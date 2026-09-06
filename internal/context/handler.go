package humancontext

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/state"
	basesession "github.com/abagile/tokyo3-base/session"
)

const csrfScope = "flux/human-context"

// Handler exposes browser-only context planning and confirmation endpoints.
// Read-only context queries live in the API package and may use a machine
// credential; these write routes always require a browser session.
type Handler struct {
	service  *Service
	sessions *basesession.Manager
}

// NewHandler constructs the human context approval endpoints.
func NewHandler(service *Service, sessions *basesession.Manager) (http.Handler, error) {
	if service == nil {
		return nil, errors.New("human context service is required")
	}
	if sessions == nil {
		return nil, errors.New("human context session manager is required")
	}
	h := &Handler{service: service, sessions: sessions}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/context/csrf", h.csrf)
	mux.HandleFunc("POST /api/context/plan", h.plan)
	mux.HandleFunc("POST /api/context/confirm", h.confirm)
	mux.HandleFunc("POST /api/context/redact/plan", h.redactPlan)
	mux.HandleFunc("POST /api/context/redact/confirm", h.confirm)
	return mux, nil
}

type contextRequest struct {
	Kind           string   `json:"kind"`
	Statement      string   `json:"statement"`
	Category       string   `json:"category"`
	ItemIDs        []string `json:"item_ids"`
	Milestone      string   `json:"milestone"`
	ScopeAction    string   `json:"scope_action"`
	DecisionOwner  string   `json:"decision_owner"`
	ReportingFrom  string   `json:"reporting_from"`
	ReportingUntil string   `json:"reporting_until"`
	EffectiveAt    string   `json:"effective_at"`
	SourceURLs     []string `json:"source_urls"`
	SupersedesID   string   `json:"supersedes_id"`
}

type redactRequest struct {
	ContextID string `json:"context_id"`
}

type confirmRequest struct {
	PlanID       string `json:"plan_id"`
	Confirmation string `json:"confirmation"`
}

func (h *Handler) csrf(w http.ResponseWriter, r *http.Request) {
	token, err := h.sessions.CSRFToken(r, csrfScope)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "human context session is unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"csrf_token": token})
}

func (h *Handler) plan(w http.ResponseWriter, r *http.Request) {
	if err := h.validateCSRF(r); err != nil {
		writeContextError(w, err)
		return
	}
	actor, err := actorFromRequest(r)
	if err != nil {
		writeContextError(w, err)
		return
	}
	var request contextRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeContextError(w, err)
		return
	}
	input, err := request.input()
	if err != nil {
		writeContextError(w, err)
		return
	}
	input.SupersedesID = request.SupersedesID
	plan, err := h.service.Plan(input, actor)
	if err != nil {
		writeContextError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "planned", "plan": plan})
}

func (h *Handler) redactPlan(w http.ResponseWriter, r *http.Request) {
	if err := h.validateCSRF(r); err != nil {
		writeContextError(w, err)
		return
	}
	actor, err := actorFromRequest(r)
	if err != nil {
		writeContextError(w, err)
		return
	}
	var request redactRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeContextError(w, err)
		return
	}
	plan, err := h.service.PlanRedaction(request.ContextID, actor)
	if err != nil {
		writeContextError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "planned", "plan": plan})
}

func (h *Handler) confirm(w http.ResponseWriter, r *http.Request) {
	if err := h.validateCSRF(r); err != nil {
		writeContextError(w, err)
		return
	}
	actor, err := actorFromRequest(r)
	if err != nil {
		writeContextError(w, err)
		return
	}
	var request confirmRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeContextError(w, err)
		return
	}
	entry, err := h.service.Confirm(r.Context(), request.PlanID, request.Confirmation, actor)
	if err != nil {
		writeContextError(w, err)
		return
	}
	status := "confirmed"
	if entry.Status == domain.ContextStatusRedacted {
		status = "redacted"
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "context": entry})
}

func (h *Handler) validateCSRF(r *http.Request) error {
	token := strings.TrimSpace(r.Header.Get("X-CSRF-Token"))
	if token == "" || !h.sessions.ValidateCSRF(r, token, csrfScope) {
		return errCSRF
	}
	return nil
}

func actorFromRequest(r *http.Request) (Actor, error) {
	sess, ok := basesession.SessionFromContext(r.Context())
	if !ok || strings.TrimSpace(sess.Subject) == "" {
		return Actor{}, ErrActorRequired
	}
	return Actor{Subject: sess.Subject, Name: sess.Name}, nil
}

func (request contextRequest) input() (Input, error) {
	from, err := parseTime(request.ReportingFrom, "reporting_from")
	if err != nil {
		return Input{}, err
	}
	until, err := parseTime(request.ReportingUntil, "reporting_until")
	if err != nil {
		return Input{}, err
	}
	effectiveAt, err := parseTime(request.EffectiveAt, "effective_at")
	if err != nil {
		return Input{}, err
	}
	return Input{
		Kind:           domain.ContextKind(strings.TrimSpace(request.Kind)),
		Statement:      request.Statement,
		Category:       request.Category,
		ItemIDs:        request.ItemIDs,
		Milestone:      request.Milestone,
		ScopeAction:    request.ScopeAction,
		DecisionOwner:  request.DecisionOwner,
		ReportingFrom:  from,
		ReportingUntil: until,
		EffectiveAt:    effectiveAt,
		SourceURLs:     request.SourceURLs,
	}, nil
}

func parseTime(raw, name string) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	value, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		if date, dateErr := time.Parse("2006-01-02", raw); dateErr == nil {
			value = date.UTC()
		} else {
			return nil, fmt.Errorf("%w: %s must be RFC3339 or YYYY-MM-DD", ErrInvalidInput, name)
		}
	}
	value = value.UTC()
	return &value, nil
}

var (
	errCSRF           = errors.New("human context request failed CSRF validation")
	errInvalidRequest = errors.New("invalid human context request")
)

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	body := http.MaxBytesReader(w, r.Body, 32<<10)
	defer body.Close()
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errInvalidRequest
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errInvalidRequest
	}
	return nil
}

func writeContextError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errCSRF):
		writeError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, ErrActorRequired):
		writeError(w, http.StatusUnauthorized, err.Error())
	case errors.Is(err, ErrRedactionForbidden):
		writeError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, state.ErrContextNotFound), errors.Is(err, ErrPlanNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, errInvalidRequest), errors.Is(err, ErrInvalidInput):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, ErrPlanExpired), errors.Is(err, ErrConfirmationRequired), errors.Is(err, ErrContextConflict):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, ErrPlanLimit):
		writeError(w, http.StatusTooManyRequests, err.Error())
	case errors.Is(err, ErrContextUnavailable):
		writeError(w, http.StatusInternalServerError, "human context persistence failed")
	default:
		writeError(w, http.StatusInternalServerError, "human context request failed")
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
