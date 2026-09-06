package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/state"
)

// Handler exposes the first read-only HTTP API and mounts the webhook handler.
type Handler struct {
	store           state.Reader
	webhook         http.Handler
	staleAfter      time.Duration
	milestoneSource MilestoneSource
	target          string
	goal            string
}

// MilestoneSource supplies active milestones and on-demand snapshots for the
// authenticated cockpit picker. Implementations keep GitLab credentials
// server-side.
type MilestoneSource interface {
	ListMilestones(context.Context, string) ([]domain.Milestone, error)
	SnapshotForMilestone(context.Context, string, string, string) (domain.Snapshot, error)
}

// NewHandler constructs the HTTP routes for Flux using the reconciled snapshot
// for the default view.
func NewHandler(store state.Reader, webhook http.Handler, staleAfter time.Duration) http.Handler {
	return NewHandlerWithMilestones(store, webhook, staleAfter, nil, "", "")
}

// NewHandlerWithMilestones constructs the HTTP routes with active milestone
// listing and per-request milestone selection enabled.
func NewHandlerWithMilestones(store state.Reader, webhook http.Handler, staleAfter time.Duration, source MilestoneSource, target, goal string) http.Handler {
	h := &Handler{
		store:           store,
		webhook:         webhook,
		staleAfter:      staleAfter,
		milestoneSource: source,
		target:          strings.TrimSpace(target),
		goal:            goal,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.health)
	mux.HandleFunc("GET /readyz", h.ready)
	mux.HandleFunc("GET /api/milestones", h.milestones)
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
	Total       int            `json:"total"`
	Counts      map[string]int `json:"counts"`
	Items       []itemResponse `json:"items"`
}

type sprintResponse struct {
	Name string `json:"name"`
	Goal string `json:"goal"`
}

type itemResponse struct {
	ID            string                `json:"id"`
	ProjectID     int                   `json:"project_id,omitempty"`
	ProjectPath   string                `json:"project_path,omitempty"`
	Title         string                `json:"title"`
	State         domain.IssueState     `json:"state"`
	Assignee      string                `json:"assignee,omitempty"`
	Blocked       bool                  `json:"blocked"`
	LastActivity  time.Time             `json:"last_activity"`
	Status        domain.Status         `json:"status"`
	MergeRequests []domain.MergeRequest `json:"merge_requests,omitempty"`
}

func (h *Handler) milestones(w http.ResponseWriter, r *http.Request) {
	if h.milestoneSource == nil || h.target == "" {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"status": "unavailable",
			"error":  "milestone selection is not configured",
		})
		return
	}
	milestones, err := h.milestoneSource.ListMilestones(r.Context(), h.target)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"status": "unavailable",
			"error":  "GitLab milestone lookup failed",
		})
		return
	}
	current := ""
	if snapshot, ok := h.store.Get(); ok {
		current = snapshot.Sprint.Name
	}
	response := milestonesResponse{
		Current:    current,
		Milestones: make([]milestoneResponse, 0, len(milestones)),
	}
	for _, milestone := range milestones {
		response.Milestones = append(response.Milestones, milestoneResponse{
			Name:      milestone.Name,
			Goal:      milestone.Goal,
			State:     milestone.State,
			StartDate: milestone.StartDate,
			DueDate:   milestone.DueDate,
		})
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) today(w http.ResponseWriter, r *http.Request) {
	var snapshot domain.Snapshot
	var ok bool
	selected := strings.TrimSpace(r.URL.Query().Get("milestone"))
	if selected != "" {
		if h.milestoneSource == nil || h.target == "" {
			writeJSON(w, http.StatusNotImplemented, map[string]string{
				"status": "unavailable",
				"error":  "milestone selection is not configured",
			})
			return
		}
		var err error
		snapshot, err = h.milestoneSource.SnapshotForMilestone(r.Context(), h.target, selected, h.goal)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{
				"status": "unavailable",
				"error":  "GitLab milestone snapshot failed",
			})
			return
		}
	} else {
		snapshot, ok = h.store.Get()
		if !ok {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "syncing"})
			return
		}
	}
	h.writeSnapshot(w, snapshot)
}

type milestonesResponse struct {
	Current    string              `json:"current,omitempty"`
	Milestones []milestoneResponse `json:"milestones"`
}

type milestoneResponse struct {
	Name      string `json:"name"`
	Goal      string `json:"goal,omitempty"`
	State     string `json:"state"`
	StartDate string `json:"start_date,omitempty"`
	DueDate   string `json:"due_date,omitempty"`
}

func (h *Handler) writeSnapshot(w http.ResponseWriter, snapshot domain.Snapshot) {
	now := snapshot.GeneratedAt
	if now.IsZero() {
		now = time.Now().UTC()
	}
	summary := domain.Summarize(snapshot.Sprint, now, h.staleAfter)
	counts := make(map[string]int)
	for _, status := range []domain.Status{
		domain.StatusTodo,
		domain.StatusInProgress,
		domain.StatusAwaitingReview,
		domain.StatusPipelineFailed,
		domain.StatusBlocked,
		domain.StatusStale,
		domain.StatusDone,
	} {
		counts[string(status)] = summary.Count(status)
	}
	response := todayResponse{
		GeneratedAt: snapshot.GeneratedAt,
		Sprint: sprintResponse{
			Name: snapshot.Sprint.Name,
			Goal: snapshot.Sprint.Goal,
		},
		Total:  summary.Total(),
		Counts: counts,
		Items:  make([]itemResponse, 0, len(summary.Items)),
	}
	for _, item := range summary.Items {
		response.Items = append(response.Items, itemResponse{
			ID:            item.Item.ID,
			ProjectID:     item.Item.ProjectID,
			ProjectPath:   item.Item.ProjectPath,
			Title:         item.Item.Title,
			State:         item.Item.State,
			Assignee:      item.Item.Assignee,
			Blocked:       item.Item.Blocked,
			LastActivity:  item.Item.LastActivity,
			Status:        item.Status,
			MergeRequests: item.Item.MergeRequests,
		})
	}
	writeJSON(w, http.StatusOK, response)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
