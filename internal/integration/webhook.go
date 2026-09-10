package integration

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/abagile/tokyo3-base/ratelimit"
)

var ErrDeliveryConflict = errors.New("delivery ID reused with different content")

// Hint contains routing only. Provider statuses, URLs, titles, and commands are
// never passed to the queue. Missing pipeline MR association fans out only to
// registered MRs in this approved GitLab project, not to project discovery.
type Hint struct {
	Kind                string
	Project, Number, MR int64
}
type Enqueue func(context.Context, string, string, string, Hint) error

func NewWebhook(secret, instance string, enqueue Enqueue, log *slog.Logger) (http.Handler, error) {
	if len(secret) < 32 || strings.TrimSpace(secret) == "" || strings.ContainsAny(secret, "\r\n") || instance == "" || enqueue == nil {
		return nil, errors.New("webhook requires a configured connector and a secret of at least 32 characters")
	}
	if log == nil {
		log = slog.Default()
	}
	expected := sha256.Sum256([]byte(secret))
	slots := make(chan struct{}, 4)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		fail := func(status int) {
			log.Warn("native GitLab webhook rejected", "status", status)
			http.Error(w, http.StatusText(status), status)
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			fail(http.StatusMethodNotAllowed)
			return
		}
		actual := sha256.Sum256([]byte(r.Header.Get("X-Gitlab-Token")))
		if subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
			fail(http.StatusUnauthorized)
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			w.Header().Set("Retry-After", "5")
			fail(http.StatusTooManyRequests)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
				fail(http.StatusRequestEntityTooLarge)
			} else {
				fail(http.StatusBadRequest)
			}
			return
		}
		var data struct {
			ObjectKind string `json:"object_kind"`
			Project    struct {
				ID int64 `json:"id"`
			} `json:"project"`
			Attributes struct {
				ID        int64 `json:"id"`
				IID       int64 `json:"iid"`
				ProjectID int64 `json:"project_id"`
			} `json:"object_attributes"`
			MR struct {
				IID             int64 `json:"iid"`
				ProjectID       int64 `json:"project_id"`
				TargetProjectID int64 `json:"target_project_id"`
			} `json:"merge_request"`
		}
		if json.Unmarshal(body, &data) != nil {
			fail(http.StatusBadRequest)
			return
		}
		hint := Hint{Project: data.Project.ID}
		switch r.Header.Get("X-Gitlab-Event") {
		case "Merge Request Hook":
			if data.ObjectKind != "merge_request" {
				fail(http.StatusBadRequest)
				return
			}
			hint.Kind = "mr"
			hint.Number = data.Attributes.IID
		case "Pipeline Hook":
			if data.ObjectKind != "pipeline" || data.Attributes.ProjectID != 0 && data.Attributes.ProjectID != hint.Project {
				fail(http.StatusBadRequest)
				return
			}
			hint.Kind = "pipeline"
			hint.Number = data.Attributes.ID
			if (data.MR.ProjectID == 0 || data.MR.ProjectID == hint.Project) && (data.MR.TargetProjectID == 0 || data.MR.TargetProjectID == hint.Project) {
				hint.MR = data.MR.IID
			}
		case "Push Hook":
			if data.ObjectKind != "push" {
				fail(http.StatusBadRequest)
				return
			}
			hint.Kind = "push"
		default:
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"accepted":true}`))
			return
		}
		if hint.Project <= 0 || hint.Project > p.MaxExternalID || hint.Number < 0 || hint.Number > p.MaxExternalID || hint.Kind != "push" && hint.Number == 0 || hint.MR < 0 || hint.MR > p.MaxExternalID {
			fail(http.StatusBadRequest)
			return
		}
		sum := sha256.Sum256(append([]byte(r.Header.Get("X-Gitlab-Event")+"\n"), body...))
		digest := hex.EncodeToString(sum[:])
		delivery := r.Header.Get("X-Gitlab-Webhook-UUID")
		if delivery == "" {
			delivery = r.Header.Get("X-Gitlab-Event-UUID")
		}
		if delivery == "" {
			delivery = "sha256:" + digest
		}
		if len(delivery) > 200 || strings.IndexFunc(delivery, func(r rune) bool { return r < 33 || r > 126 }) >= 0 {
			fail(http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if err = enqueue(ctx, instance, delivery, digest, hint); err != nil {
			if errors.Is(err, ErrDeliveryConflict) {
				fail(http.StatusConflict)
			} else {
				fail(http.StatusServiceUnavailable)
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"accepted":true}`))
	})
	return ratelimit.New(ratelimit.Config{RPS: 5, Burst: 20, Log: log}).Middleware(handler), nil
}
