package api

import (
	"encoding/json"
	"net/http"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/state"
)

// Handler exposes the first read-only HTTP API and mounts the webhook handler.
type Handler struct {
	store      state.Reader
	webhook    http.Handler
	staleAfter time.Duration
}

// NewHandler constructs the HTTP routes for Flux.
func NewHandler(store state.Reader, webhook http.Handler, staleAfter time.Duration) http.Handler {
	h := &Handler{store: store, webhook: webhook, staleAfter: staleAfter}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.health)
	mux.HandleFunc("GET /readyz", h.ready)
	mux.HandleFunc("GET /api/today", h.today)
	mux.Handle("POST /webhooks/gitlab", webhook)
	return mux
}

func (h *Handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) ready(w http.ResponseWriter, _ *http.Request) {
	if _, ok := h.store.Get(); !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "syncing"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

type todayResponse struct {
	GeneratedAt time.Time      `json:"generated_at"`
	Sprint      sprintResponse `json:"sprint"`
	Items       []itemResponse `json:"items"`
}

type sprintResponse struct {
	Name string `json:"name"`
	Goal string `json:"goal"`
}

type itemResponse struct {
	ID          string        `json:"id"`
	ProjectID   int           `json:"project_id,omitempty"`
	ProjectPath string        `json:"project_path,omitempty"`
	Title       string        `json:"title"`
	Assignee    string        `json:"assignee,omitempty"`
	Status      domain.Status `json:"status"`
}

func (h *Handler) today(w http.ResponseWriter, _ *http.Request) {
	snapshot, ok := h.store.Get()
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "syncing"})
		return
	}
	now := snapshot.GeneratedAt
	if now.IsZero() {
		now = time.Now().UTC()
	}
	summary := domain.Summarize(snapshot.Sprint, now, h.staleAfter)
	response := todayResponse{
		GeneratedAt: snapshot.GeneratedAt,
		Sprint: sprintResponse{
			Name: snapshot.Sprint.Name,
			Goal: snapshot.Sprint.Goal,
		},
		Items: make([]itemResponse, 0, len(summary.Items)),
	}
	for _, item := range summary.Items {
		response.Items = append(response.Items, itemResponse{
			ID:          item.Item.ID,
			ProjectID:   item.Item.ProjectID,
			ProjectPath: item.Item.ProjectPath,
			Title:       item.Item.Title,
			Assignee:    item.Item.Assignee,
			Status:      item.Status,
		})
	}
	writeJSON(w, http.StatusOK, response)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
