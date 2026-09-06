package api

import (
	"errors"
	"net/http"
	"strings"

	basesession "github.com/abagile/tokyo3-base/session"
)

const syncCSRFScope = "flux/reconcile"

// SyncController queues one pull reconciliation. It must not perform the
// pull in the HTTP handler; the background reconciler owns that work.
type SyncController interface {
	Trigger()
}

type syncHandler struct {
	controller SyncController
	sessions   *basesession.Manager
}

// NewSyncHandler constructs the browser-only manual pull endpoint. Read-only
// machine credentials are intentionally not accepted for the POST operation.
func NewSyncHandler(controller SyncController, sessions *basesession.Manager) (http.Handler, error) {
	if controller == nil {
		return nil, errors.New("sync controller is required")
	}
	if sessions == nil {
		return nil, errors.New("sync session manager is required")
	}
	h := &syncHandler{controller: controller, sessions: sessions}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/sync/csrf", h.csrf)
	mux.HandleFunc("POST /api/sync", h.trigger)
	return mux, nil
}

func (h *syncHandler) csrf(w http.ResponseWriter, r *http.Request) {
	token, err := h.sessions.CSRFToken(r, syncCSRFScope)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"status": "error", "error": "sync session is unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"csrf_token": token})
}

func (h *syncHandler) trigger(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.Header.Get("X-CSRF-Token"))
	if token == "" || !h.sessions.ValidateCSRF(r, token, syncCSRFScope) {
		writeJSON(w, http.StatusForbidden, map[string]string{"status": "error", "error": "sync request failed CSRF validation"})
		return
	}
	h.controller.Trigger()
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "queued"})
}
