package action

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	basesession "github.com/abagile/tokyo3-base/session"
)

const (
	csrfScope               = "flux/gitlab-actions"
	mutationDisabledMessage = "GitLab mutations disabled: FLUX_GITLAB_WRITE_TOKEN is not configured."
)

var ErrCSRF = errors.New("action request failed CSRF validation")

// Handler exposes browser-only label catalog, plan, and confirmation endpoints.
// It must be wrapped in a session gate; machine Bearer credentials are intentionally not
// accepted for these routes.
type Handler struct {
	service  *Service
	sessions *basesession.Manager
}

// NewHandler constructs the browser mutation endpoints.
func NewHandler(service *Service, sessions *basesession.Manager) (http.Handler, error) {
	if service == nil {
		return nil, errors.New("action service is required")
	}
	if sessions == nil {
		return nil, errors.New("action session manager is required")
	}
	h := &Handler{service: service, sessions: sessions}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/actions/csrf", h.csrf)
	mux.HandleFunc("GET /api/actions/status", h.status)
	mux.HandleFunc("GET /api/actions/labels", h.labels)
	mux.HandleFunc("POST /api/actions/labels/plan", h.planLabel)
	mux.HandleFunc("POST /api/actions/labels/confirm", h.confirmLabel)
	return mux, nil
}

type addLabelPlanRequest struct {
	ItemID string `json:"item_id"`
	Label  string `json:"label"`
}

type addLabelConfirmRequest struct {
	PlanID       string `json:"plan_id"`
	Confirmation string `json:"confirmation"`
}

func (h *Handler) csrf(w http.ResponseWriter, r *http.Request) {
	token, err := h.sessions.CSRFToken(r, csrfScope)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "action session is unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"csrf_token": token})
}

func (h *Handler) status(w http.ResponseWriter, r *http.Request) {
	if _, err := actorFromRequest(r); err != nil {
		writeActionError(w, err)
		return
	}
	enabled := h.service.MutationEnabled()
	response := map[string]any{
		"status":           "enabled",
		"mutation_enabled": enabled,
	}
	if !enabled {
		response["status"] = "disabled"
		response["message"] = mutationDisabledMessage
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) labels(w http.ResponseWriter, r *http.Request) {
	if _, err := actorFromRequest(r); err != nil {
		writeActionError(w, err)
		return
	}
	labels, err := h.service.AvailableLabels(r.Context(), r.URL.Query().Get("item_id"))
	if err != nil {
		writeActionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "labels": labels})
}

func (h *Handler) planLabel(w http.ResponseWriter, r *http.Request) {
	if err := h.validateCSRF(r); err != nil {
		writeActionError(w, err)
		return
	}
	if !h.service.MutationEnabled() {
		writeActionError(w, ErrMutationUnavailable)
		return
	}
	var request addLabelPlanRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeActionError(w, err)
		return
	}
	actor, err := actorFromRequest(r)
	if err != nil {
		writeActionError(w, err)
		return
	}
	plan, err := h.service.PlanAddLabel(r.Context(), request.ItemID, request.Label, actor)
	if err != nil {
		writeActionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "planned", "plan": plan})
}

func (h *Handler) confirmLabel(w http.ResponseWriter, r *http.Request) {
	if err := h.validateCSRF(r); err != nil {
		writeActionError(w, err)
		return
	}
	if !h.service.MutationEnabled() {
		writeActionError(w, ErrMutationUnavailable)
		return
	}
	var request addLabelConfirmRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeActionError(w, err)
		return
	}
	actor, err := actorFromRequest(r)
	if err != nil {
		writeActionError(w, err)
		return
	}
	result, err := h.service.ConfirmAddLabel(r.Context(), request.PlanID, request.Confirmation, actor)
	if err != nil {
		writeActionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "applied", "result": result})
}

func (h *Handler) validateCSRF(r *http.Request) error {
	token := strings.TrimSpace(r.Header.Get("X-CSRF-Token"))
	if token == "" || !h.sessions.ValidateCSRF(r, token, csrfScope) {
		return ErrCSRF
	}
	return nil
}

func actorFromRequest(r *http.Request) (Actor, error) {
	sess, ok := basesession.SessionFromContext(r.Context())
	if !ok || strings.TrimSpace(sess.Subject) == "" {
		return Actor{}, ErrActorRequired
	}
	return Actor{Subject: strings.TrimSpace(sess.Subject), Name: strings.TrimSpace(sess.Name)}, nil
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	body := http.MaxBytesReader(w, r.Body, 16<<10)
	defer body.Close()
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return ErrInvalidRequest
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return ErrInvalidRequest
	}
	return nil
}

func writeActionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrCSRF):
		writeError(w, http.StatusForbidden, "action request failed CSRF validation")
	case errors.Is(err, ErrActorRequired):
		writeError(w, http.StatusUnauthorized, "authenticated action actor is required")
	case errors.Is(err, ErrInvalidRequest):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, ErrTargetNotFound), errors.Is(err, ErrPlanNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, ErrActionConflict), errors.Is(err, ErrLabelUnavailable), errors.Is(err, ErrPlanExpired), errors.Is(err, ErrConfirmationRequired):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, ErrSnapshotUnavailable):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, ErrMutationUnavailable):
		writeError(w, http.StatusServiceUnavailable, mutationDisabledMessage)
	case errors.Is(err, ErrGitLabUnavailable):
		writeError(w, http.StatusBadGateway, "GitLab action lookup or update failed")
	case errors.Is(err, ErrAuditUnavailable):
		writeError(w, http.StatusInternalServerError, "action audit logging failed")
	default:
		writeError(w, http.StatusInternalServerError, "GitLab action failed")
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"status": "error", "error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
