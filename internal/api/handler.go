package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
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
	syncSource      SyncStatusSource
	historySource   state.HistoryReader
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

// SyncStatusSource supplies operational metadata for the pull reconciler.
type SyncStatusSource interface {
	SyncStatus() domain.SyncStatus
}

// NewHandler constructs the HTTP routes for Flux using the reconciled snapshot
// for the default view.
func NewHandler(store state.Reader, webhook http.Handler, staleAfter time.Duration) http.Handler {
	return NewHandlerWithMilestonesAndHistory(store, webhook, staleAfter, nil, "", "", nil, nil)
}

// NewHandlerWithMilestones constructs the HTTP routes with active milestone
// listing and per-request milestone selection enabled.
func NewHandlerWithMilestones(store state.Reader, webhook http.Handler, staleAfter time.Duration, source MilestoneSource, target, goal string) http.Handler {
	return NewHandlerWithMilestonesAndHistory(store, webhook, staleAfter, source, target, goal, nil, nil)
}

// NewHandlerWithSync constructs the HTTP routes with milestone selection and
// pull reconciliation status enabled.
func NewHandlerWithSync(store state.Reader, webhook http.Handler, staleAfter time.Duration, source MilestoneSource, target, goal string, syncSource SyncStatusSource) http.Handler {
	return NewHandlerWithMilestonesAndHistory(store, webhook, staleAfter, source, target, goal, syncSource, nil)
}

// NewHandlerWithMilestonesAndHistory constructs the read API with optional
// milestone, sync-status, and historical change views.
func NewHandlerWithMilestonesAndHistory(store state.Reader, webhook http.Handler, staleAfter time.Duration, source MilestoneSource, target, goal string, syncSource SyncStatusSource, historySource state.HistoryReader) http.Handler {
	h := &Handler{
		store:           store,
		webhook:         webhook,
		staleAfter:      staleAfter,
		milestoneSource: source,
		syncSource:      syncSource,
		historySource:   historySource,
		target:          strings.TrimSpace(target),
		goal:            goal,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.health)
	mux.HandleFunc("GET /readyz", h.ready)
	mux.HandleFunc("GET /api/milestones", h.milestones)
	mux.HandleFunc("GET /api/sync/status", h.syncStatus)
	mux.HandleFunc("GET /api/changes", h.changes)
	mux.HandleFunc("GET /api/items/", h.itemHistory)
	mux.HandleFunc("GET /api/snapshots/", h.snapshotAt)
	mux.HandleFunc("GET /api/flow", h.flow)
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

func (h *Handler) syncStatus(w http.ResponseWriter, _ *http.Request) {
	if h.syncSource == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"status": "unavailable",
			"error":  "sync status is not configured",
		})
		return
	}
	status := h.syncSource.SyncStatus()
	response := syncStatusResponse{
		State:          string(status.State),
		LastDurationMS: status.LastDuration.Milliseconds(),
		LastError:      status.LastError,
	}
	if !status.LastStartedAt.IsZero() {
		value := status.LastStartedAt
		response.LastStartedAt = &value
	}
	if !status.LastCompletedAt.IsZero() {
		value := status.LastCompletedAt
		response.LastCompletedAt = &value
	}
	if snapshot, ok := h.store.Get(); ok && !snapshot.GeneratedAt.IsZero() {
		value := snapshot.GeneratedAt
		response.SnapshotGeneratedAt = &value
	}
	writeJSON(w, http.StatusOK, response)
}

type syncStatusResponse struct {
	State               string     `json:"state"`
	LastStartedAt       *time.Time `json:"last_started_at,omitempty"`
	LastCompletedAt     *time.Time `json:"last_completed_at,omitempty"`
	LastDurationMS      int64      `json:"last_duration_ms"`
	LastError           string     `json:"last_error,omitempty"`
	SnapshotGeneratedAt *time.Time `json:"snapshot_generated_at,omitempty"`
}

type changesResponse struct {
	Status           string                `json:"status"`
	HistoryStartedAt *time.Time            `json:"history_started_at,omitempty"`
	LastObservedAt   *time.Time            `json:"last_observed_at,omitempty"`
	Observations     int                   `json:"observations"`
	Changes          []state.Change        `json:"changes"`
	Coverage         state.HistoryCoverage `json:"coverage"`
}

type snapshotResponse struct {
	Status string `json:"status"`
	state.SnapshotResult
}

type flowResponse struct {
	Status string `json:"status"`
	state.FlowResult
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
	Labels        []string              `json:"labels,omitempty"`
	Blocked       bool                  `json:"blocked"`
	LastActivity  time.Time             `json:"last_activity"`
	Status        domain.Status         `json:"status"`
	MergeRequests []domain.MergeRequest `json:"merge_requests,omitempty"`
}

func (h *Handler) changes(w http.ResponseWriter, r *http.Request) {
	if h.historySource == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"status": "unavailable",
			"error":  "history is not configured",
		})
		return
	}
	query, err := parseChangeQuery(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"status": "invalid",
			"error":  err.Error(),
		})
		return
	}
	result, err := h.historySource.Changes(query)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"status": "unavailable",
			"error":  "history lookup failed",
		})
		return
	}
	writeJSON(w, http.StatusOK, changesResponse{
		Status:           "ok",
		HistoryStartedAt: result.HistoryStartedAt,
		LastObservedAt:   result.LastObservedAt,
		Observations:     result.Observations,
		Changes:          result.Changes,
		Coverage:         result.Coverage,
	})
}

func (h *Handler) itemHistory(w http.ResponseWriter, r *http.Request) {
	if h.historySource == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"status": "unavailable",
			"error":  "history is not configured",
		})
		return
	}
	itemID, err := pathValue(r, "/api/items/", "/history")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid", "error": err.Error()})
		return
	}
	query, err := parseChangeQuery(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid", "error": err.Error()})
		return
	}
	if _, supplied := r.URL.Query()["include_baseline"]; !supplied {
		query.IncludeBaseline = true
	}
	query.ItemID = itemID
	result, err := h.historySource.Changes(query)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"status": "unavailable", "error": "history lookup failed"})
		return
	}
	writeJSON(w, http.StatusOK, changesResponse{
		Status:           "ok",
		HistoryStartedAt: result.HistoryStartedAt,
		LastObservedAt:   result.LastObservedAt,
		Observations:     result.Observations,
		Changes:          result.Changes,
		Coverage:         result.Coverage,
	})
}

func (h *Handler) snapshotAt(w http.ResponseWriter, r *http.Request) {
	reader, ok := h.historySource.(state.SnapshotReader)
	if !ok {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"status": "unavailable",
			"error":  "historical snapshots are not configured",
		})
		return
	}
	rawTimestamp, err := pathValue(r, "/api/snapshots/", "")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid", "error": err.Error()})
		return
	}
	at, err := time.Parse(time.RFC3339Nano, rawTimestamp)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid", "error": "snapshot timestamp must be RFC3339"})
		return
	}
	result, err := reader.SnapshotAt(at)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.HasPrefix(err.Error(), "no historical observation") {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"status": "unavailable", "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, snapshotResponse{Status: "ok", SnapshotResult: result})
}

func (h *Handler) flow(w http.ResponseWriter, r *http.Request) {
	reader, ok := h.historySource.(state.FlowReader)
	if !ok {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"status": "unavailable",
			"error":  "flow history is not configured",
		})
		return
	}
	query, err := parseFlowQuery(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "invalid", "error": err.Error()})
		return
	}
	result, err := reader.Flow(query)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"status": "unavailable", "error": "flow lookup failed"})
		return
	}
	writeJSON(w, http.StatusOK, flowResponse{Status: "ok", FlowResult: result})
}

func pathValue(r *http.Request, prefix, suffix string) (string, error) {
	path := r.URL.EscapedPath()
	if !strings.HasPrefix(path, prefix) || (suffix != "" && !strings.HasSuffix(path, suffix)) {
		return "", errors.New("invalid resource path")
	}
	value := strings.TrimPrefix(path, prefix)
	if suffix != "" {
		value = strings.TrimSuffix(value, suffix)
	}
	if value == "" || strings.Contains(value, "/") && suffix == "" {
		// A slash in a timestamp is never valid. Encoded slashes remain
		// escaped until PathUnescape below for item IDs.
		return "", errors.New("resource identifier is required")
	}
	decoded, err := url.PathUnescape(value)
	if err != nil || strings.TrimSpace(decoded) == "" {
		return "", errors.New("resource identifier must be URL-encoded")
	}
	return strings.TrimSpace(decoded), nil
}

func parseFlowQuery(r *http.Request) (state.FlowQuery, error) {
	values := r.URL.Query()
	from, err := parseQueryTime(values.Get("from"), "from")
	if err != nil {
		return state.FlowQuery{}, err
	}
	until, err := parseQueryTime(values.Get("to"), "to")
	if err != nil {
		return state.FlowQuery{}, err
	}
	if !from.IsZero() && !until.IsZero() && !until.After(from) {
		return state.FlowQuery{}, errors.New("to must be after from")
	}
	return state.FlowQuery{
		From:      from,
		Until:     until,
		ItemID:    strings.TrimSpace(values.Get("item_id")),
		Milestone: strings.TrimSpace(values.Get("milestone")),
	}, nil
}

func parseChangeQuery(r *http.Request) (state.ChangeQuery, error) {
	values := r.URL.Query()
	since, err := parseQueryTime(values.Get("since"), "since")
	if err != nil {
		return state.ChangeQuery{}, err
	}
	until, err := parseQueryTime(values.Get("until"), "until")
	if err != nil {
		return state.ChangeQuery{}, err
	}
	if !since.IsZero() && !until.IsZero() && !until.After(since) {
		return state.ChangeQuery{}, errors.New("until must be after since")
	}
	limit := 0
	if raw := strings.TrimSpace(values.Get("limit")); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > state.MaxHistoryLimit {
			return state.ChangeQuery{}, fmt.Errorf("limit must be between 1 and %d", state.MaxHistoryLimit)
		}
	}
	includeBaseline := false
	if raw := strings.TrimSpace(values.Get("include_baseline")); raw != "" {
		includeBaseline, err = strconv.ParseBool(raw)
		if err != nil {
			return state.ChangeQuery{}, errors.New("include_baseline must be true or false")
		}
	}
	return state.ChangeQuery{
		Since:           since,
		Until:           until,
		ItemID:          strings.TrimSpace(values.Get("item_id")),
		Milestone:       strings.TrimSpace(values.Get("milestone")),
		Limit:           limit,
		IncludeBaseline: includeBaseline,
	}, nil
}

func parseQueryTime(raw, name string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, fmt.Errorf("%s must be RFC3339", name)
	}
	return parsed, nil
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
			Labels:        append([]string(nil), item.Item.Labels...),
			Blocked:       item.Item.Blocked,
			LastActivity:  item.Item.LastActivity,
			Status:        item.Status,
			MergeRequests: item.Item.MergeRequests,
		})
	}
	writeJSON(w, http.StatusOK, response)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
