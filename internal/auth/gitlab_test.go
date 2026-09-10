package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/abagile/tokyo3-base/session"
)

func TestGitLabOAuthLogin(t *testing.T) {
	var tokenRequest url.Values
	var tokenUsername, tokenPassword string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth/token":
			if err := r.ParseForm(); err != nil {
				t.Errorf("parse token form: %v", err)
			}
			tokenRequest = r.Form
			tokenUsername, tokenPassword, _ = r.BasicAuth()
			writeJSON(t, w, map[string]any{
				"access_token": "access-token",
				"token_type":   "Bearer",
				"expires_in":   3600,
			})
		case "/api/v4/user":
			if got, want := r.Header.Get("Authorization"), "Bearer access-token"; got != want {
				t.Errorf("Authorization = %q, want %q", got, want)
			}
			writeJSON(t, w, map[string]any{
				"id":       42,
				"username": "alex",
				"name":     "Alex Example",
				"email":    "alex@example.test",
				"state":    "active",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	manager := newTestSessionManager(t)
	authenticator, err := NewGitLab(Config{
		GitLabURL:    server.URL,
		ClientID:     "flux-client",
		ClientSecret: "flux-secret",
		RedirectURL:  "http://flux.example.test/auth/callback",
	}, manager)
	if err != nil {
		t.Fatalf("NewGitLab() error = %v", err)
	}

	loginRequest := httptest.NewRequest(http.MethodGet, "/auth/login?return_to="+url.QueryEscape("/api/v2/workspaces/w/read/board"), nil)
	loginResponse := httptest.NewRecorder()
	authenticator.Handler().ServeHTTP(loginResponse, loginRequest)
	if got, want := loginResponse.Code, http.StatusSeeOther; got != want {
		t.Fatalf("login status = %d, want %d", got, want)
	}
	location, err := url.Parse(loginResponse.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse login location: %v", err)
	}
	if got, want := location.Path, "/oauth/authorize"; got != want {
		t.Fatalf("authorize path = %q, want %q", got, want)
	}
	if got, want := location.Query().Get("client_id"), "flux-client"; got != want {
		t.Errorf("client_id = %q, want %q", got, want)
	}
	state := location.Query().Get("state")
	challenge := location.Query().Get("code_challenge")
	if state == "" || challenge == "" || location.Query().Get("code_challenge_method") != "S256" {
		t.Fatal("authorize URL is missing state or PKCE parameters")
	}
	cookies := loginResponse.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("login cookies = %d, want one flow cookie", len(cookies))
	}

	callbackRequest := httptest.NewRequest(http.MethodGet, "/auth/callback?code=auth-code&state="+url.QueryEscape(state), nil)
	callbackRequest.AddCookie(cookies[0])
	callbackResponse := httptest.NewRecorder()
	authenticator.Handler().ServeHTTP(callbackResponse, callbackRequest)
	if got, want := callbackResponse.Code, http.StatusSeeOther; got != want {
		t.Fatalf("callback status = %d, want %d", got, want)
	}
	if got, want := callbackResponse.Header().Get("Location"), "/api/v2/workspaces/w/read/board"; got != want {
		t.Errorf("callback location = %q, want %q", got, want)
	}
	if tokenUsername != "flux-client" || tokenPassword != "flux-secret" || tokenRequest.Get("code") != "auth-code" {
		t.Fatalf("token request = %v (basic auth %q/%q), missing OAuth fields", tokenRequest, tokenUsername, tokenPassword)
	}
	if pkceChallenge(tokenRequest.Get("code_verifier")) != challenge {
		t.Fatalf("code verifier does not match challenge: verifier=%q challenge=%q", tokenRequest.Get("code_verifier"), challenge)
	}

	var sessionCookie *http.Cookie
	for _, cookie := range callbackResponse.Result().Cookies() {
		if cookie.Name == "flux_session" {
			sessionCookie = cookie
			break
		}
	}
	if sessionCookie == nil {
		t.Fatal("callback did not issue a session cookie")
	}
	protected := manager.Gate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, ok := session.SessionFromContext(r.Context())
		if !ok {
			t.Error("session missing from context")
			return
		}
		if sess.Subject != "42" || sess.Name != "Alex Example" || sess.Email != "alex@example.test" {
			t.Errorf("session = %+v, want GitLab identity", sess)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	protectedRequest := httptest.NewRequest(http.MethodGet, "/api/v2/workspaces/w/read/board", nil)
	protectedRequest.AddCookie(sessionCookie)
	protectedResponse := httptest.NewRecorder()
	protected.ServeHTTP(protectedResponse, protectedRequest)
	if protectedResponse.Code != http.StatusNoContent {
		t.Fatalf("protected status = %d, want %d", protectedResponse.Code, http.StatusNoContent)
	}
}

func TestGitLabOAuthRejectsStateMismatch(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	manager := newTestSessionManager(t)
	authenticator, err := NewGitLab(Config{
		GitLabURL:    server.URL,
		ClientID:     "client",
		ClientSecret: "secret",
		RedirectURL:  "http://flux.example.test/auth/callback",
	}, manager)
	if err != nil {
		t.Fatalf("NewGitLab() error = %v", err)
	}

	loginRequest := httptest.NewRequest(http.MethodGet, "/auth/login", nil)
	loginResponse := httptest.NewRecorder()
	authenticator.Handler().ServeHTTP(loginResponse, loginRequest)
	cookie := loginResponse.Result().Cookies()[0]
	callbackRequest := httptest.NewRequest(http.MethodGet, "/auth/callback?code=code&state=wrong", nil)
	callbackRequest.AddCookie(cookie)
	callbackResponse := httptest.NewRecorder()
	authenticator.Handler().ServeHTTP(callbackResponse, callbackRequest)
	if callbackResponse.Code != http.StatusBadRequest {
		t.Fatalf("state mismatch status = %d, want %d", callbackResponse.Code, http.StatusBadRequest)
	}
}

func TestNewGitLabValidation(t *testing.T) {
	manager := newTestSessionManager(t)
	tests := []struct {
		name string
		cfg  Config
	}{
		{name: "missing URL", cfg: Config{ClientID: "client", ClientSecret: "secret", RedirectURL: "http://flux.test/callback"}},
		{name: "missing client ID", cfg: Config{GitLabURL: "https://gitlab.test", ClientSecret: "secret", RedirectURL: "http://flux.test/callback"}},
		{name: "missing client secret", cfg: Config{GitLabURL: "https://gitlab.test", ClientID: "client", RedirectURL: "http://flux.test/callback"}},
		{name: "missing redirect URL", cfg: Config{GitLabURL: "https://gitlab.test", ClientID: "client", ClientSecret: "secret"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewGitLab(test.cfg, manager); err == nil {
				t.Fatal("NewGitLab() error = nil, want validation error")
			}
		})
	}
}

func newTestSessionManager(t *testing.T) *session.Manager {
	t.Helper()
	manager, err := session.New(session.Config{
		SessionKey:   []byte(strings.Repeat("k", 32)),
		CookiePrefix: "flux",
		SessionTTL:   time.Hour,
		ExemptPaths:  []string{"/auth/callback"},
	})
	if err != nil {
		t.Fatalf("session.New() error = %v", err)
	}
	return manager
}

func writeJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Errorf("encode response: %v", err)
	}
}
