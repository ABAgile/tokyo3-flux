package integration

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSettings(t *testing.T) {
	for _, key := range []string{"FLUX_GITLAB_URL", "FLUX_GITLAB_SERVICE_TOKEN", "FLUX_GITLAB_REFRESH_INTERVAL", "FLUX_GITLAB_WEBHOOK_SECRET"} {
		t.Setenv(key, "")
	}
	t.Setenv("FLUX_GITLAB_URL", "https://login.example")
	cfg, err := FromEnv()
	if err != nil || cfg.Client != nil || cfg.Interval != 0 {
		t.Fatal(cfg, err)
	}
	t.Setenv("FLUX_GITLAB_SERVICE_TOKEN", "read-secret")
	cfg, err = FromEnv()
	if err != nil || cfg.Client.Instance() != "https://login.example" || cfg.Client.token != "read-secret" || cfg.Interval != time.Minute {
		t.Fatal(cfg, err)
	}
	t.Setenv("FLUX_GITLAB_URL", "")
	if _, err := FromEnv(); err == nil {
		t.Fatal("service token requires an instance URL")
	}
	t.Setenv("FLUX_GITLAB_URL", "https://login.example")
	for _, value := range []string{"garbage", "-1s", "29s", "2h"} {
		t.Setenv("FLUX_GITLAB_REFRESH_INTERVAL", value)
		if _, err := FromEnv(); err == nil {
			t.Fatal("accepted", value)
		}
	}
	t.Setenv("FLUX_GITLAB_REFRESH_INTERVAL", "0")
	cfg, err = FromEnv()
	if err != nil || cfg.Interval != 0 {
		t.Fatal(cfg, err)
	}
	t.Setenv("FLUX_GITLAB_WEBHOOK_SECRET", strings.Repeat("s", 32))
	if _, err := FromEnv(); err == nil {
		t.Fatal("webhook without workers")
	}
	t.Setenv("FLUX_GITLAB_REFRESH_INTERVAL", "1m")
	if _, err := FromEnv(); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"short", strings.Repeat(" ", 32)} {
		t.Setenv("FLUX_GITLAB_WEBHOOK_SECRET", secret)
		if _, err := FromEnv(); err == nil {
			t.Fatal("weak webhook secret")
		}
	}
}

const mrHint = `{"object_kind":"merge_request","project":{"id":42},"object_attributes":{"iid":7,"state":"merged"},"url":"http://internal/secret","command":"move cards"}`

func TestNativeWebhook(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	secret := strings.Repeat("s", 32)
	for _, tc := range []struct {
		name, method, event, body, token string
		status                           int
	}{
		{"MR", "POST", "Merge Request Hook", mrHint, secret, 202},
		{"pipeline", "POST", "Pipeline Hook", `{"object_kind":"pipeline","project":{"id":42},"object_attributes":{"id":77},"merge_request":{"iid":7}}`, secret, 202},
		{"push", "POST", "Push Hook", `{"object_kind":"push","project":{"id":42}}`, secret, 202},
		{"unauthenticated", "POST", "Merge Request Hook", mrHint, "wrong", 401},
		{"method", "GET", "Merge Request Hook", mrHint, secret, 405},
		{"oversize", "POST", "Merge Request Hook", strings.Repeat("x", (1<<20)+1), secret, 413},
		{"malformed", "POST", "Merge Request Hook", "{} garbage", secret, 400},
		{"wrong kind", "POST", "Pipeline Hook", mrHint, secret, 400},
		{"bad project", "POST", "Push Hook", `{"object_kind":"push","project":{"id":-1}}`, secret, 400},
		{"ignored issue", "POST", "Issue Hook", `{"object_kind":"issue"}`, secret, 202},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			h, err := NewWebhook(secret, "https://gitlab.example", func(_ context.Context, instance, id, digest string, hint Hint) error {
				calls++
				if instance != "https://gitlab.example" || hint.Project != 42 || len(digest) != 64 || id == "" {
					t.Fatal(instance, id, digest, hint)
				}
				return nil
			}, log)
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest(tc.method, "/webhooks/gitlab", strings.NewReader(tc.body))
			r.Header.Set("X-Gitlab-Token", tc.token)
			r.Header.Set("X-Gitlab-Event", tc.event)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatal(w.Code, w.Body.String())
			}
			if (tc.status != 202 || tc.name == "ignored issue") && calls != 0 {
				t.Fatal("invalid/irrelevant request queued")
			}
		})
	}
	if _, err := NewWebhook("short", "https://gitlab.example", nil, log); err == nil {
		t.Fatal("weak config")
	}
}
func TestWebhookRetryIdentityAndRateLimit(t *testing.T) {
	secret := strings.Repeat("s", 32)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ids := []string{}
	h, _ := NewWebhook(secret, "https://gitlab.example", func(_ context.Context, _, id, _ string, _ Hint) error {
		ids = append(ids, id)
		return ErrDeliveryConflict
	}, log)
	for i := range 22 {
		r := httptest.NewRequest("POST", "/webhooks/gitlab", strings.NewReader(mrHint))
		r.Header.Set("X-Gitlab-Token", secret)
		r.Header.Set("X-Gitlab-Event", "Merge Request Hook")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if i == 0 && w.Code != 409 {
			t.Fatal(w.Code)
		}
		if i == 21 && w.Code != 429 {
			t.Fatal("unbounded ingress", w.Code)
		}
	}
	if len(ids) < 2 || ids[0] != ids[1] {
		t.Fatal("fallback identity is not stable", ids)
	}
	// UUID headers take precedence and are not derived from object states.
	h, _ = NewWebhook(secret, "https://gitlab.example", func(_ context.Context, _, id, _ string, _ Hint) error {
		if id != "delivery-uuid" {
			t.Fatal(id)
		}
		return nil
	}, log)
	r := httptest.NewRequest(http.MethodPost, "/webhooks/gitlab", strings.NewReader(mrHint))
	r.Header.Set("X-Gitlab-Token", secret)
	r.Header.Set("X-Gitlab-Event", "Merge Request Hook")
	r.Header.Set("X-Gitlab-Webhook-UUID", "delivery-uuid")
	h.ServeHTTP(httptest.NewRecorder(), r)
}
