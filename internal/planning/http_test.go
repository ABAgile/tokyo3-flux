package planning

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	fluxauth "abagile.com/tokyo3/flux/internal/auth"
	"github.com/abagile/tokyo3-base/session"
)

type fakeRepository struct {
	changes int
	subject string
	err     error
}

func (f *fakeRepository) Workspaces(_ context.Context, subject string) ([]Workspace, error) {
	f.subject = subject
	return []Workspace{}, f.err
}
func (f *fakeRepository) Projects(_ context.Context, _, subject string) ([]Project, error) {
	f.subject = subject
	return []Project{}, f.err
}
func (f *fakeRepository) Board(_ context.Context, _, subject string) (Board, error) {
	f.subject = subject
	return testBoard(), f.err
}
func (f *fakeRepository) Change(_ context.Context, _, subject, _ string, _ Command) (int64, error) {
	f.changes++
	f.subject = subject
	return 2, f.err
}
func (f *fakeRepository) History(_ context.Context, _, subject string, _ int64) ([]Event, error) {
	f.subject = subject
	return []Event{}, f.err
}
func (f *fakeRepository) Burndown(_ context.Context, _, subject, _, _, _ string) (Burndown, error) {
	f.subject = subject
	return Burndown{Version: 1, WorkspaceID: "w", Sprint: testBoard().Sprints[0], Points: []BurndownPoint{}}, f.err
}

func TestHTTPAuthenticationAndCSRF(t *testing.T) {
	manager, err := session.New(session.Config{SessionKey: []byte(strings.Repeat("s", 32)), CookiePrefix: "test"})
	if err != nil {
		t.Fatal(err)
	}
	login, _ := fluxauth.NewFixture(manager)
	lr := httptest.NewRecorder()
	login.ServeHTTP(lr, httptest.NewRequest("GET", "http://localhost/auth/login", nil))
	cookies := lr.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("no session")
	}
	repo := &fakeRepository{}
	h := NewHTTP(repo, manager, "machine-viewer", true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	browser := manager.Gate(h.Handler(false))
	var csrf string
	mint := manager.Gate(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { csrf, err = manager.CSRFToken(r, "planning") }))
	req := httptest.NewRequest("GET", "http://localhost/", nil)
	req.AddCookie(cookies[0])
	mint.ServeHTTP(httptest.NewRecorder(), req)
	if err != nil || csrf == "" {
		t.Fatal("no csrf", err)
	}
	root := "http://localhost/api/v2/workspaces/w"
	tests := []struct {
		name, method, path, body, token, auth string
		cookie                                bool
		status                                int
	}{
		{name: "anonymous", method: "GET", path: "/board", status: 303},
		{name: "read", method: "GET", path: "/board", cookie: true, status: 200},
		{name: "burn down", method: "GET", path: "/burndown?sprint=s1&project=all&assignee=all", cookie: true, status: 200},
		{name: "native read", method: "GET", path: "/read/board?limit=1", cookie: true, status: 200},
		{name: "native bad page", method: "GET", path: "/read/board?limit=51", cookie: true, status: 400},
		{name: "native stale page", method: "GET", path: "/read/board?offset=1", cookie: true, status: 409},
		{name: "proposal missing csrf", method: "POST", path: "/changes", body: `{"kind":"proposal.import"}`, cookie: true, status: 403},
		{name: "proposal unknown executable field", method: "POST", path: "/changes", body: `{"kind":"proposal.import","proposal":{"operations":[{"shell":"id"}]}}`, cookie: true, token: csrf, status: 400},
		{name: "missing csrf", method: "POST", path: "/changes", body: `{"kind":"item.create","revision":1}`, cookie: true, status: 403},
		{name: "refresh missing csrf", method: "POST", path: "/changes", body: `{"kind":"link.refresh","target":"link","revision":1}`, cookie: true, status: 403},
		{name: "arbitrary fetch URL rejected", method: "POST", path: "/changes", body: `{"kind":"link.attach","link":{"url":"http://internal/secrets"}}`, cookie: true, token: csrf, status: 400},
		{name: "invalid csrf", method: "POST", path: "/changes", body: `{}`, token: "bad", cookie: true, status: 403},
		{name: "valid change", method: "POST", path: "/changes", body: `{"kind":"item.archive","revision":1,"target":"a"}`, token: csrf, cookie: true, status: 200},
		{name: "bearer with session", method: "POST", path: "/changes", body: `{}`, token: csrf, auth: "Bearer nope", cookie: true, status: 403},
		{name: "unknown field", method: "POST", path: "/changes", body: `{"sql":"DROP TABLE work_items"}`, token: csrf, cookie: true, status: 400},
		{name: "trailing JSON", method: "POST", path: "/changes", body: `{} {}`, token: csrf, cookie: true, status: 400},
		{name: "oversized", method: "POST", path: "/changes", body: `{"reason":"` + strings.Repeat("a", 70<<10) + `"}`, token: csrf, cookie: true, status: 400},
		{name: "bad pagination", method: "GET", path: "/history?before=-1", cookie: true, status: 400},
		{name: "history", method: "GET", path: "/history?before=5", cookie: true, status: 200},
		{name: "project planning route retired", method: "POST", path: "/projects/p/changes", body: `{}`, token: csrf, cookie: true, status: 404},
		{name: "legacy sprint field rejected", method: "POST", path: "/changes", body: `{"kind":"item.create","item":{"sprint_id":"s"}}`, token: csrf, cookie: true, status: 400},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, root+tc.path, strings.NewReader(tc.body))
			if tc.cookie {
				r.AddCookie(cookies[0])
			}
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF-Token", tc.token)
			r.Header.Set("Authorization", tc.auth)
			r.Header.Set("Idempotency-Key", NewID())
			w := httptest.NewRecorder()
			browser.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("got %d: %s", w.Code, w.Body.String())
			}
		})
	}
	if repo.changes != 1 {
		t.Fatalf("unauthorized changes reached repository: %d", repo.changes)
	}
	for _, path := range []string{"/api/v2/session", "/api/v2/workspaces", "/api/v2/workspaces/w/projects"} {
		r := httptest.NewRequest("GET", "http://localhost"+path, nil)
		r.AddCookie(cookies[0])
		w := httptest.NewRecorder()
		browser.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	token, _ := fluxauth.NewMachineToken(strings.Repeat("m", 32))
	machine := token.Gate(h.Handler(true), browser)
	for _, method := range []string{"GET", "POST", "PATCH", "DELETE"} {
		r := httptest.NewRequest(method, root+"/board", nil)
		r.Header.Set("Authorization", "Bearer "+strings.Repeat("m", 32))
		w := httptest.NewRecorder()
		machine.ServeHTTP(w, r)
		want := 405
		if method == "GET" {
			want = 200
		}
		if w.Code != want {
			t.Fatalf("machine %s got %d", method, w.Code)
		}
	}
	for _, kind := range []string{"integration.save", "link.attach", "link.detach", "link.refresh", "proposal.import", "proposal.accept", "proposal.reject"} {
		r := httptest.NewRequest("POST", root+"/changes", strings.NewReader(`{"kind":"`+kind+`","revision":1}`))
		r.Header.Set("Authorization", "Bearer "+strings.Repeat("m", 32))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF-Token", csrf)
		r.AddCookie(cookies[0])
		w := httptest.NewRecorder()
		machine.ServeHTTP(w, r)
		if w.Code != http.StatusMethodNotAllowed || repo.changes != 1 {
			t.Fatalf("machine %s accepted: %d", kind, w.Code)
		}
	}
	if repo.subject != "machine-viewer" {
		t.Fatalf("machine not scoped: %s", repo.subject)
	}
	for _, testErr := range []error{ErrInvalid, ErrConflict, ErrForbidden, ErrNotFound, io.ErrUnexpectedEOF} {
		repo.err = testErr
		r := httptest.NewRequest("GET", root+"/board", nil)
		r.AddCookie(cookies[0])
		w := httptest.NewRecorder()
		browser.ServeHTTP(w, r)
		if w.Code < 400 {
			t.Fatal("repository error hidden")
		}
	}
	// Handler itself remains fail-closed even when accidentally mounted without gates.
	w := httptest.NewRecorder()
	h.Handler(false).ServeHTTP(w, httptest.NewRequest("GET", root+"/board", nil))
	if w.Code != 403 {
		t.Fatal("ungated read accepted")
	}
	w = httptest.NewRecorder()
	h.Handler(true).ServeHTTP(w, httptest.NewRequest("POST", root+"/changes", strings.NewReader(`{}`)))
	if w.Code != 403 {
		t.Fatal("ungated machine write accepted")
	}
}
