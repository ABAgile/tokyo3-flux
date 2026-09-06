package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	basesession "github.com/abagile/tokyo3-base/session"
)

type fakeSyncController struct {
	triggers int
}

func (f *fakeSyncController) Trigger() {
	f.triggers++
}

func TestSyncHandlerRequiresSessionCSRFAndQueuesPull(t *testing.T) {
	controller := &fakeSyncController{}
	sessions, err := basesession.New(basesession.Config{
		SessionKey:   bytes.Repeat([]byte{0x33}, 32),
		CookiePrefix: "flux",
		SessionTTL:   time.Hour,
	})
	if err != nil {
		t.Fatalf("session.New() error = %v", err)
	}
	handler, err := NewSyncHandler(controller, sessions)
	if err != nil {
		t.Fatalf("NewSyncHandler() error = %v", err)
	}
	gated := sessions.Gate(handler)

	unauthenticated := httptest.NewRequest(http.MethodPost, "/api/sync", nil)
	unauthenticatedResponse := httptest.NewRecorder()
	gated.ServeHTTP(unauthenticatedResponse, unauthenticated)
	if unauthenticatedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", unauthenticatedResponse.Code, http.StatusUnauthorized)
	}

	loginRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	loginResponse := httptest.NewRecorder()
	sess, err := sessions.NewSession()
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	sess.Subject = "user-1"
	if err := sessions.IssueSession(loginResponse, loginRequest, sess); err != nil {
		t.Fatalf("IssueSession() error = %v", err)
	}
	cookie := loginResponse.Result().Cookies()[0]

	csrfRequest := httptest.NewRequest(http.MethodGet, "/api/sync/csrf", nil)
	csrfRequest.AddCookie(cookie)
	csrfResponse := httptest.NewRecorder()
	gated.ServeHTTP(csrfResponse, csrfRequest)
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("CSRF status = %d, want %d", csrfResponse.Code, http.StatusOK)
	}
	var csrf struct {
		Token string `json:"csrf_token"`
	}
	if err := json.NewDecoder(csrfResponse.Body).Decode(&csrf); err != nil {
		t.Fatalf("decode CSRF response: %v", err)
	}
	if csrf.Token == "" {
		t.Fatal("CSRF token is empty")
	}

	missingCSRF := httptest.NewRequest(http.MethodPost, "/api/sync", nil)
	missingCSRF.AddCookie(cookie)
	missingCSRFResponse := httptest.NewRecorder()
	gated.ServeHTTP(missingCSRFResponse, missingCSRF)
	if missingCSRFResponse.Code != http.StatusForbidden {
		t.Fatalf("missing CSRF status = %d, want %d", missingCSRFResponse.Code, http.StatusForbidden)
	}

	syncRequest := httptest.NewRequest(http.MethodPost, "/api/sync", nil)
	syncRequest.AddCookie(cookie)
	syncRequest.Header.Set("X-CSRF-Token", csrf.Token)
	syncResponse := httptest.NewRecorder()
	gated.ServeHTTP(syncResponse, syncRequest)
	if syncResponse.Code != http.StatusAccepted || controller.triggers != 1 {
		t.Fatalf("sync response = %d, triggers = %d; want 202 and one trigger", syncResponse.Code, controller.triggers)
	}
	var body map[string]string
	if err := json.NewDecoder(syncResponse.Body).Decode(&body); err != nil {
		t.Fatalf("decode sync response: %v", err)
	}
	if body["status"] != "queued" {
		t.Fatalf("sync response body = %v, want queued", body)
	}
}
