package webhook

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const defaultMaxBodyBytes int64 = 1 << 20

// Config controls validation for a GitLab group webhook.
type Config struct {
	Secret        string
	ExpectedGroup string
	Trigger       func()
	OnEvent       func(Event) error
	MaxBodyBytes  int64
}

// Event is the small amount of webhook metadata needed by the first
// reconciler. The payload itself is deliberately not trusted as a state
// source and is not retained.
type Event struct {
	Kind        string
	DeliveryID  string
	ProjectID   int
	ProjectPath string
	GroupID     int
	GroupPath   string
	ReceivedAt  time.Time
}

// Handler authenticates GitLab webhook deliveries and wakes the reconciler.
type Handler struct {
	secret        [sha256.Size]byte
	expectedGroup string
	trigger       func()
	onEvent       func(Event) error
	maxBodyBytes  int64
}

// New validates webhook configuration.
func New(cfg Config) (*Handler, error) {
	if strings.TrimSpace(cfg.Secret) == "" {
		return nil, errors.New("GitLab webhook secret is required")
	}
	if cfg.Trigger == nil {
		return nil, errors.New("GitLab webhook trigger is required")
	}
	if cfg.OnEvent == nil {
		cfg.OnEvent = func(Event) error { return nil }
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = defaultMaxBodyBytes
	}
	return &Handler{
		secret:        sha256.Sum256([]byte(cfg.Secret)),
		expectedGroup: strings.TrimSpace(cfg.ExpectedGroup),
		trigger:       cfg.Trigger,
		onEvent:       cfg.OnEvent,
		maxBodyBytes:  cfg.MaxBodyBytes,
	}, nil
}

// ServeHTTP accepts authenticated GitLab webhook deliveries and responds
// immediately. Reconciliation runs asynchronously after the response.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !h.validToken(r.Header.Get("X-Gitlab-Token")) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, h.maxBodyBytes+1))
	if err != nil {
		http.Error(w, "cannot read webhook", http.StatusBadRequest)
		return
	}
	if int64(len(body)) > h.maxBodyBytes {
		http.Error(w, "webhook payload too large", http.StatusRequestEntityTooLarge)
		return
	}

	var payload struct {
		GroupID int `json:"group_id"`
		Group   struct {
			ID       int    `json:"id"`
			FullPath string `json:"full_path"`
			Path     string `json:"path"`
		} `json:"group"`
		Project struct {
			ID                int    `json:"id"`
			PathWithNamespace string `json:"path_with_namespace"`
			Namespace         struct {
				ID       int    `json:"id"`
				FullPath string `json:"full_path"`
			} `json:"namespace"`
		} `json:"project"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(w, "invalid webhook JSON", http.StatusBadRequest)
		return
	}
	groupID := payload.GroupID
	if groupID == 0 {
		groupID = payload.Group.ID
	}
	if groupID == 0 {
		groupID = payload.Project.Namespace.ID
	}
	groupPath := strings.TrimSpace(payload.Group.FullPath)
	if groupPath == "" {
		groupPath = strings.TrimSpace(payload.Project.Namespace.FullPath)
	}
	if !h.scopeMatches(payload.Project.PathWithNamespace, groupID, groupPath) {
		http.Error(w, "webhook scope mismatch", http.StatusForbidden)
		return
	}

	event := Event{
		Kind:        strings.TrimSpace(r.Header.Get("X-Gitlab-Event")),
		DeliveryID:  strings.TrimSpace(r.Header.Get("X-Gitlab-Webhook-UUID")),
		ProjectID:   payload.Project.ID,
		ProjectPath: payload.Project.PathWithNamespace,
		GroupID:     groupID,
		GroupPath:   groupPath,
		ReceivedAt:  time.Now().UTC(),
	}
	if event.Kind == "" {
		http.Error(w, "missing GitLab event header", http.StatusBadRequest)
		return
	}

	if err := h.onEvent(event); err != nil {
		http.Error(w, "webhook could not be recorded", http.StatusServiceUnavailable)
		return
	}
	h.trigger()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_, _ = fmt.Fprint(w, `{"accepted":true}`)
}

func (h *Handler) validToken(token string) bool {
	actual := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(h.secret[:], actual[:]) == 1
}

func (h *Handler) scopeMatches(projectPath string, groupID int, groupPath string) bool {
	if h.expectedGroup == "" {
		return true
	}

	expected := strings.Trim(strings.TrimSpace(h.expectedGroup), "/")
	if expected == "" {
		return true
	}
	if expected == strconv.Itoa(groupID) && groupID != 0 {
		return true
	}
	if groupPathMatches(expected, groupPath) || groupPathMatches(expected, projectPath) {
		return true
	}
	// Some GitLab group webhook payloads contain only the project object. A
	// numeric group target cannot be checked against that payload, but the
	// webhook secret still authenticates the delivery.
	return isNumeric(expected) && groupID == 0 && strings.TrimSpace(groupPath) == ""
}

func groupPathMatches(group, path string) bool {
	group = strings.Trim(strings.TrimSpace(group), "/")
	path = strings.Trim(strings.TrimSpace(path), "/")
	return group != "" && (path == group || strings.HasPrefix(path, group+"/"))
}

func isNumeric(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}
