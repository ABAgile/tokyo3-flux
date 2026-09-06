package auth

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/abagile/tokyo3-base/session"
)

func TestFixtureAuthIssuesLocalSession(t *testing.T) {
	sessions, err := session.New(session.Config{
		SessionKey:   bytes.Repeat([]byte{0x44}, 32),
		CookiePrefix: "flux",
		SessionTTL:   time.Hour,
	})
	if err != nil {
		t.Fatalf("session.New() error = %v", err)
	}
	handler, err := NewFixture(sessions)
	if err != nil {
		t.Fatalf("NewFixture() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/auth/login?return_to=%2Fdashboard", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusSeeOther || response.Header().Get("Location") != "/dashboard" {
		t.Fatalf("login response = %d, location %q", response.Code, response.Header().Get("Location"))
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("login cookies = %d, want one", len(cookies))
	}

	protected := sessions.Gate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, ok := session.SessionFromContext(r.Context())
		if !ok || sess.Subject != "fixture-user" || sess.Name != "Local fixture user" {
			t.Fatalf("fixture session = %+v, present = %v", sess, ok)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	protectedRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	protectedRequest.AddCookie(cookies[0])
	protectedResponse := httptest.NewRecorder()
	protected.ServeHTTP(protectedResponse, protectedRequest)
	if protectedResponse.Code != http.StatusNoContent {
		t.Fatalf("protected response = %d, want %d", protectedResponse.Code, http.StatusNoContent)
	}
}
