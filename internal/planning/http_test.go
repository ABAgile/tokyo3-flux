package planning

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	fluxauth "abagile.com/tokyo3/flux/internal/auth"
	"abagile.com/tokyo3/flux/internal/blobstore"
	"github.com/abagile/tokyo3-base/session"
)

type fakeRepository struct {
	changes          int
	boardReads       int
	workspaceCreates int
	commentAdds      int
	subject          string
	err              error
	attachment       Attachment
	archived         []Item
}

func (f *fakeRepository) Workspaces(_ context.Context, subject string) ([]Workspace, error) {
	f.subject = subject
	return []Workspace{}, f.err
}
func (f *fakeRepository) Projects(_ context.Context, _, subject string) ([]Project, error) {
	f.subject = subject
	return []Project{}, f.err
}
func (f *fakeRepository) CreateWorkspace(_ context.Context, name, subject, _ string) (Workspace, error) {
	f.workspaceCreates++
	f.subject = subject
	return Workspace{ID: "created", Name: name, Role: "admin", Revision: 1}, f.err
}
func (f *fakeRepository) GitLabProjects(_ context.Context, _, subject string) ([]GitLabProject, error) {
	f.subject = subject
	return []GitLabProject{{ID: 42, Name: "Flux", PathWithNamespace: "team/flux"}}, f.err
}
func (f *fakeRepository) GitLabUsers(_ context.Context, _, subject, _ string) ([]GitLabUser, error) {
	f.subject = subject
	return []GitLabUser{{ID: 42, Username: "alex", Name: "Alex Example"}}, f.err
}
func (f *fakeRepository) Proposals(_ context.Context, _, subject string, _ int64) ([]ProposalSummary, error) {
	f.subject = subject
	return []ProposalSummary{}, f.err
}
func (f *fakeRepository) Review(_ context.Context, _, subject, _ string) (ProposalPreview, error) {
	f.subject = subject
	return ProposalPreview{}, f.err
}
func (f *fakeRepository) gitLabMergeRequests(_ context.Context, _, subject string, project int64, _ string) ([]GitLabMergeRequest, error) {
	f.subject = subject
	return []GitLabMergeRequest{{ProjectID: project, IID: 7, Title: "Latest change", State: "opened"}}, f.err
}
func (f *fakeRepository) GitLabMergeRequestsFor(ctx context.Context, workspace, subject string, project int64, search, _ string) ([]GitLabMergeRequest, error) {
	return f.gitLabMergeRequests(ctx, workspace, subject, project, search)
}
func (f *fakeRepository) Board(_ context.Context, _, subject string) (Board, error) {
	f.boardReads++
	f.subject = subject
	return testBoard(), f.err
}
func (f *fakeRepository) WorkspaceState(_ context.Context, _, subject string) (WorkspaceState, error) {
	f.subject = subject
	return WorkspaceState{Revision: 1, Role: "admin", Links: "digest"}, f.err
}
func (f *fakeRepository) ArchivedItems(_ context.Context, _, subject string, offset, limit int) ([]Item, error) {
	f.subject = subject
	if f.err != nil {
		return nil, f.err
	}
	if offset >= len(f.archived) {
		return []Item{}, nil
	}
	return f.archived[offset:min(offset+limit, len(f.archived))], nil
}
func (f *fakeRepository) Item(_ context.Context, _, subject, item string) (ItemView, error) {
	f.subject = subject
	if f.err != nil {
		return ItemView{}, f.err
	}
	board := testBoard()
	for _, candidate := range append(board.Items, f.archived...) {
		if candidate.ID == item {
			return ItemView{Item: candidate, Role: board.Role, Revision: board.Workspace.Revision}, nil
		}
	}
	return ItemView{}, ErrNotFound
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
func (f *fakeRepository) Comments(_ context.Context, _, subject, item string) ([]Comment, error) {
	f.subject = subject
	return []Comment{{ID: 1, ItemID: item, Author: subject, Body: "existing comment"}}, f.err
}
func (f *fakeRepository) AddComment(_ context.Context, _, subject, item, _, body string) (Comment, error) {
	f.commentAdds++
	f.subject = subject
	return Comment{ID: 2, ItemID: item, Author: subject, Body: body}, f.err
}
func (f *fakeRepository) Attachments(_ context.Context, _, subject, item string) ([]Attachment, error) {
	f.subject = subject
	if f.attachment.ID == 0 || f.attachment.ItemID != item {
		return []Attachment{}, f.err
	}
	return []Attachment{f.attachment}, f.err
}
func (f *fakeRepository) Attachment(_ context.Context, _, subject, item string, id int64) (Attachment, error) {
	f.subject = subject
	if f.attachment.ID != id || f.attachment.ItemID != item {
		return Attachment{}, ErrNotFound
	}
	return f.attachment, f.err
}
func (f *fakeRepository) AddAttachment(_ context.Context, _, subject, item, key, _ string, attachment Attachment) (Attachment, error) {
	f.subject = subject
	f.attachment = attachment
	f.attachment.ID = 1
	f.attachment.ItemID = item
	f.attachment.StorageKey = key
	f.attachment.Uploader = subject
	f.attachment.CreatedAt = time.Now().UTC()
	return f.attachment, f.err
}
func (f *fakeRepository) RemoveAttachment(_ context.Context, _, subject, item string, id int64) (Attachment, error) {
	f.subject = subject
	if f.attachment.ID != id || f.attachment.ItemID != item {
		return Attachment{}, ErrNotFound
	}
	attachment := f.attachment
	f.attachment = Attachment{}
	return attachment, f.err
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
	h := NewHTTP(repo, manager, "machine-viewer", true, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
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
		name, method, path, url, body, token, auth string
		cookie                                     bool
		status                                     int
	}{
		{name: "anonymous", method: "GET", path: "/board", status: 303},
		{name: "read", method: "GET", path: "/board", cookie: true, status: 200},
		{name: "create workspace", method: "POST", url: "http://localhost/api/v2/workspaces", body: `{"name":"Team Alpha"}`, cookie: true, token: csrf, status: 201},
		{name: "create workspace bearer", method: "POST", url: "http://localhost/api/v2/workspaces", body: `{"name":"Team Alpha"}`, cookie: true, token: csrf, auth: "Bearer browser-credential", status: 403},
		{name: "create workspace unknown field", method: "POST", url: "http://localhost/api/v2/workspaces", body: `{"name":"Team Alpha","subject":"spoofed"}`, cookie: true, token: csrf, status: 400},
		{name: "comments", method: "GET", path: "/items/a/comments", cookie: true, status: 200},
		{name: "comment missing csrf", method: "POST", path: "/items/a/comments", body: `{"body":"hello"}`, cookie: true, status: 403},
		{name: "comment", method: "POST", path: "/items/a/comments", body: `{"body":"hello"}`, cookie: true, token: csrf, status: 200},
		{name: "comment unknown field", method: "POST", path: "/items/a/comments", body: `{"body":"hello","author":"spoof"}`, cookie: true, token: csrf, status: 400},
		{name: "burn down", method: "GET", path: "/burndown?sprint=s1&project=all&assignee=all", cookie: true, status: 200},
		{name: "merge-request search", method: "GET", path: "/gitlab/merge-requests?project=42&search=latest", cookie: true, status: 200},
		{name: "gitlab users", method: "GET", path: "/gitlab/users?search=alex", cookie: true, status: 200},
		{name: "gitlab users bad search", method: "GET", path: "/gitlab/users?search=%0A", cookie: true, status: 400},
		{name: "merge-request assigned", method: "GET", path: "/gitlab/merge-requests?project=42&scope=assigned_to_me", cookie: true, status: 200},
		{name: "merge-request board members", method: "GET", path: "/gitlab/merge-requests?project=42&scope=board_members", cookie: true, status: 200},
		{name: "merge-request bad scope", method: "GET", path: "/gitlab/merge-requests?project=42&scope=unsafe", cookie: true, status: 400},
		{name: "merge-request bad project", method: "GET", path: "/gitlab/merge-requests?project=0", cookie: true, status: 400},
		{name: "merge-request bad search", method: "GET", path: "/gitlab/merge-requests?project=42&search=%0A", cookie: true, status: 400},
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
		{name: "archive default page", method: "GET", path: "/archive", cookie: true, status: 200},
		{name: "archive explicit page", method: "GET", path: "/archive?offset=1&limit=2", cookie: true, status: 200},
		{name: "archive negative offset", method: "GET", path: "/archive?offset=-1", cookie: true, status: 400},
		{name: "archive zero limit", method: "GET", path: "/archive?limit=0", cookie: true, status: 400},
		{name: "archive oversized limit", method: "GET", path: "/archive?limit=" + strconv.Itoa(ArchivePageLimit+1), cookie: true, status: 400},
		{name: "archive unparsable page", method: "GET", path: "/archive?offset=x", cookie: true, status: 400},
		{name: "shared card link", method: "GET", path: "/items/a", cookie: true, status: 200},
		{name: "shared card link anonymous", method: "GET", path: "/items/a", status: 303},
		{name: "shared card link unknown item", method: "GET", path: "/items/missing", cookie: true, status: 404},
		{name: "shared card link malformed item", method: "GET", path: "/items/%0a", cookie: true, status: 400},
		{name: "freshness probe", method: "GET", path: "/revision", cookie: true, status: 200},
		{name: "bad pagination", method: "GET", path: "/history?before=-1", cookie: true, status: 400},
		{name: "history", method: "GET", path: "/history?before=5", cookie: true, status: 200},
		{name: "project planning route retired", method: "POST", path: "/projects/p/changes", body: `{}`, token: csrf, cookie: true, status: 404},
		{name: "legacy sprint field rejected", method: "POST", path: "/changes", body: `{"kind":"item.create","item":{"sprint_id":"s"}}`, token: csrf, cookie: true, status: 400},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			target := tc.url
			if target == "" {
				target = root + tc.path
			}
			r := httptest.NewRequest(tc.method, target, strings.NewReader(tc.body))
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
	missingKey := httptest.NewRequest("POST", "http://localhost/api/v2/workspaces", strings.NewReader(`{"name":"Missing key"}`))
	missingKey.AddCookie(cookies[0])
	missingKey.Header.Set("Content-Type", "application/json")
	missingKey.Header.Set("X-CSRF-Token", csrf)
	missingKeyResponse := httptest.NewRecorder()
	browser.ServeHTTP(missingKeyResponse, missingKey)
	if missingKeyResponse.Code != http.StatusBadRequest {
		t.Fatalf("missing workspace idempotency key got %d", missingKeyResponse.Code)
	}
	if repo.changes != 1 || repo.commentAdds != 1 || repo.workspaceCreates != 1 || repo.subject != "fixture-user" {
		t.Fatalf("unexpected writes reached repository: planning=%d comments=%d workspaces=%d subject=%q", repo.changes, repo.commentAdds, repo.workspaceCreates, repo.subject)
	}
	for _, path := range []string{"/api/v2/session", "/api/v2/workspaces", "/api/v2/workspaces/w/projects", "/api/v2/workspaces/w/gitlab/projects", "/api/v2/workspaces/w/gitlab/users?search=alex"} {
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
	machineWorkspace := httptest.NewRecorder()
	machineWorkspaceRequest := httptest.NewRequest("POST", "http://localhost/api/v2/workspaces", strings.NewReader(`{"name":"Machine workspace"}`))
	machineWorkspaceRequest.Header.Set("Authorization", "Bearer "+strings.Repeat("m", 32))
	machineWorkspaceRequest.Header.Set("Content-Type", "application/json")
	machine.ServeHTTP(machineWorkspace, machineWorkspaceRequest)
	if machineWorkspace.Code != http.StatusMethodNotAllowed {
		t.Fatalf("machine workspace creation got %d", machineWorkspace.Code)
	}
	machineProjects := httptest.NewRecorder()
	machineProjectRequest := httptest.NewRequest("GET", root+"/gitlab/projects", nil)
	machineProjectRequest.Header.Set("Authorization", "Bearer "+strings.Repeat("m", 32))
	machine.ServeHTTP(machineProjects, machineProjectRequest)
	if machineProjects.Code != http.StatusForbidden {
		t.Fatalf("machine project catalog got %d", machineProjects.Code)
	}
	machineMergeRequests := httptest.NewRecorder()
	machineMergeRequest := httptest.NewRequest("GET", root+"/gitlab/merge-requests?project=42", nil)
	machineMergeRequest.Header.Set("Authorization", "Bearer "+strings.Repeat("m", 32))
	machine.ServeHTTP(machineMergeRequests, machineMergeRequest)
	if machineMergeRequests.Code != http.StatusForbidden {
		t.Fatalf("machine merge-request search got %d", machineMergeRequests.Code)
	}
	machineUsers := httptest.NewRecorder()
	machineUserRequest := httptest.NewRequest("GET", root+"/gitlab/users?search=alex", nil)
	machineUserRequest.Header.Set("Authorization", "Bearer "+strings.Repeat("m", 32))
	machine.ServeHTTP(machineUsers, machineUserRequest)
	if machineUsers.Code != http.StatusForbidden {
		t.Fatalf("machine user catalog got %d", machineUsers.Code)
	}
	machineComments := httptest.NewRecorder()
	machineCommentRequest := httptest.NewRequest("GET", root+"/items/a/comments", nil)
	machineCommentRequest.Header.Set("Authorization", "Bearer "+strings.Repeat("m", 32))
	machine.ServeHTTP(machineComments, machineCommentRequest)
	if machineComments.Code != http.StatusOK {
		t.Fatalf("machine comments read got %d", machineComments.Code)
	}
	machineCommentWrite := httptest.NewRecorder()
	machineCommentWriteRequest := httptest.NewRequest("POST", root+"/items/a/comments", strings.NewReader(`{"body":"machine write"}`))
	machineCommentWriteRequest.Header.Set("Authorization", "Bearer "+strings.Repeat("m", 32))
	machineCommentWriteRequest.Header.Set("Content-Type", "application/json")
	machine.ServeHTTP(machineCommentWrite, machineCommentWriteRequest)
	if machineCommentWrite.Code != http.StatusMethodNotAllowed || repo.commentAdds != 1 {
		t.Fatalf("machine comments write accepted: %d", machineCommentWrite.Code)
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

func TestHTTPAttachments(t *testing.T) {
	manager, err := session.New(session.Config{SessionKey: []byte(strings.Repeat("a", 32)), CookiePrefix: "attachment-test"})
	if err != nil {
		t.Fatal(err)
	}
	login, _ := fluxauth.NewFixture(manager)
	loginResponse := httptest.NewRecorder()
	login.ServeHTTP(loginResponse, httptest.NewRequest("GET", "http://localhost/auth/login", nil))
	cookies := loginResponse.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("no session")
	}
	var csrf string
	manager.Gate(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		csrf, err = manager.CSRFToken(r, "planning")
	})).ServeHTTP(httptest.NewRecorder(), func() *http.Request {
		req := httptest.NewRequest("GET", "http://localhost/", nil)
		req.AddCookie(cookies[0])
		return req
	}())
	if err != nil || csrf == "" {
		t.Fatal("no csrf", err)
	}
	repo := &fakeRepository{}
	storageRoot := t.TempDir()
	blobs, err := blobstore.NewLocal(storageRoot, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer blobs.Close()
	h := NewHTTP(repo, manager, "machine-viewer", true,
		slog.New(slog.NewTextHandler(io.Discard, nil)), blobs)
	browser := manager.Gate(h.Handler(false))
	root := "http://localhost/api/v2/workspaces/w/items/a/attachments"
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "../note.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	upload := httptest.NewRequest("POST", root, &body)
	upload.AddCookie(cookies[0])
	upload.Header.Set("Content-Type", writer.FormDataContentType())
	upload.Header.Set("X-CSRF-Token", csrf)
	upload.Header.Set("Idempotency-Key", strings.Repeat("u", 16))
	uploadResponse := httptest.NewRecorder()
	browser.ServeHTTP(uploadResponse, upload)
	if uploadResponse.Code != http.StatusCreated {
		t.Fatalf("upload status %d: %s", uploadResponse.Code, uploadResponse.Body.String())
	}
	var uploaded Attachment
	if err := json.NewDecoder(uploadResponse.Body).Decode(&uploaded); err != nil {
		t.Fatal(err)
	}
	if uploaded.ID != 1 || uploaded.Name != "note.txt" || uploaded.Size != 5 || uploaded.ContentType != "text/plain" {
		t.Fatalf("unexpected attachment: %+v", uploaded)
	}
	key := repo.attachment.StorageKey
	if strings.ContainsAny(key, "/\\") {
		t.Fatalf("attachment key created a nested path: %q", key)
	}
	get := httptest.NewRequest("GET", root+"/1", nil)
	get.AddCookie(cookies[0])
	getResponse := httptest.NewRecorder()
	browser.ServeHTTP(getResponse, get)
	if getResponse.Code != http.StatusOK || getResponse.Body.String() != "hello" {
		t.Fatalf("download status %d body %q", getResponse.Code, getResponse.Body.String())
	}
	if !strings.Contains(getResponse.Header().Get("Content-Disposition"), "note.txt") {
		t.Fatal("download filename missing")
	}
	if err := os.WriteFile(filepath.Join(storageRoot, filepath.FromSlash(key)), []byte("HELLO"), 0o600); err != nil {
		t.Fatal(err)
	}
	corrupt := httptest.NewRequest("GET", root+"/1", nil)
	corrupt.AddCookie(cookies[0])
	corruptResponse := httptest.NewRecorder()
	browser.ServeHTTP(corruptResponse, corrupt)
	if corruptResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("corrupt download status %d: %s", corruptResponse.Code, corruptResponse.Body.String())
	}
	remove := httptest.NewRequest("DELETE", root+"/1", nil)
	remove.AddCookie(cookies[0])
	remove.Header.Set("X-CSRF-Token", csrf)
	removeResponse := httptest.NewRecorder()
	browser.ServeHTTP(removeResponse, remove)
	if removeResponse.Code != http.StatusNoContent {
		t.Fatalf("remove status %d: %s", removeResponse.Code, removeResponse.Body.String())
	}
	if _, err := blobs.Open(context.Background(), key); !errors.Is(err, blobstore.ErrNotFound) {
		t.Fatalf("blob remains after removal: %v", err)
	}
}

func TestBoardConditionalRead(t *testing.T) {
	manager, err := session.New(session.Config{SessionKey: []byte(strings.Repeat("s", 32)), CookiePrefix: "test"})
	if err != nil {
		t.Fatal(err)
	}
	login, _ := fluxauth.NewFixture(manager)
	loginResponse := httptest.NewRecorder()
	login.ServeHTTP(loginResponse, httptest.NewRequest("GET", "http://localhost/auth/login", nil))
	cookies := loginResponse.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("no session")
	}
	repo := &fakeRepository{}
	h := NewHTTP(repo, manager, "machine-viewer", true, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	browser := manager.Gate(h.Handler(false))
	read := func(etag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "http://localhost/api/v2/workspaces/w/board", nil)
		r.AddCookie(cookies[0])
		if etag != "" {
			r.Header.Set("If-None-Match", etag)
		}
		w := httptest.NewRecorder()
		browser.ServeHTTP(w, r)
		return w
	}
	first := read("")
	etag := first.Header().Get("ETag")
	if first.Code != http.StatusOK || etag == "" || first.Body.Len() == 0 {
		t.Fatalf("first read: %d etag %q", first.Code, etag)
	}
	repeat := read(etag)
	if repeat.Code != http.StatusNotModified || repeat.Body.Len() != 0 {
		t.Fatalf("unchanged board resent: %d body %d", repeat.Code, repeat.Body.Len())
	}
	if repeat.Header().Get("ETag") != etag {
		t.Fatal("revalidation dropped the validator")
	}
	if stale := read(`"stale"`); stale.Code != http.StatusOK || stale.Body.Len() == 0 {
		t.Fatalf("stale validator not refilled: %d", stale.Code)
	}
}

func TestETagMatches(t *testing.T) {
	const etag = `"abc"`
	for _, header := range []string{`"abc"`, `W/"abc"`, `"other", "abc"`, ` "abc" `, "*"} {
		if !etagMatches(header, etag) {
			t.Fatalf("no match for %q", header)
		}
	}
	for _, header := range []string{"", "  ", `"other"`, `"abc-1"`, `W/"other"`} {
		if etagMatches(header, etag) {
			t.Fatalf("unexpected match for %q", header)
		}
	}
}

func TestTimeoutFor(t *testing.T) {
	attachment := "/api/v2/workspaces/w/items/i/attachments"
	for _, path := range []string{attachment, attachment + "/7"} {
		if timeoutFor(path) != attachmentRequestTimeout {
			t.Fatalf("%s did not get the transfer deadline", path)
		}
	}
	for _, path := range []string{"/api/v2/workspaces/w/board", "/api/v2/workspaces/w/items/attachmentsy/comments"} {
		if timeoutFor(path) != jsonRequestTimeout {
			t.Fatalf("%s did not get the JSON deadline", path)
		}
	}
}

// A saved change returns the committed board with the validator a conditional
// read would have produced, so the client needs no follow-up board fetch.
func TestChangeReturnsCommittedBoard(t *testing.T) {
	manager, err := session.New(session.Config{SessionKey: []byte(strings.Repeat("s", 32)), CookiePrefix: "test"})
	if err != nil {
		t.Fatal(err)
	}
	login, _ := fluxauth.NewFixture(manager)
	loginResponse := httptest.NewRecorder()
	login.ServeHTTP(loginResponse, httptest.NewRequest("GET", "http://localhost/auth/login", nil))
	cookies := loginResponse.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("no session")
	}
	var csrf string
	mint := manager.Gate(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { csrf, err = manager.CSRFToken(r, "planning") }))
	mintRequest := httptest.NewRequest("GET", "http://localhost/", nil)
	mintRequest.AddCookie(cookies[0])
	mint.ServeHTTP(httptest.NewRecorder(), mintRequest)
	if err != nil || csrf == "" {
		t.Fatal("no csrf", err)
	}
	repo := &fakeRepository{}
	h := NewHTTP(repo, manager, "machine-viewer", true, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	browser := manager.Gate(h.Handler(false))
	root := "http://localhost/api/v2/workspaces/w"

	change := httptest.NewRequest("POST", root+"/changes", strings.NewReader(`{"kind":"item.rank","revision":1,"target":"a"}`))
	change.AddCookie(cookies[0])
	change.Header.Set("Content-Type", "application/json")
	change.Header.Set("X-CSRF-Token", csrf)
	change.Header.Set("Idempotency-Key", strings.Repeat("k", 20))
	changeResponse := httptest.NewRecorder()
	browser.ServeHTTP(changeResponse, change)
	if changeResponse.Code != 200 {
		t.Fatalf("change status %d: %s", changeResponse.Code, changeResponse.Body.String())
	}
	var receipt struct {
		Revision  int64  `json:"revision"`
		BoardETag string `json:"board_etag"`
		Board     *Board `json:"board"`
	}
	if err = json.Unmarshal(changeResponse.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Revision != 2 || receipt.Board == nil || receipt.BoardETag == "" {
		t.Fatalf("receipt without a usable board: %s", changeResponse.Body.String())
	}
	// The embedded validator must be the one a board read would answer with,
	// otherwise the next refresh cannot revalidate and refetches in full.
	read := httptest.NewRequest("GET", root+"/board", nil)
	read.AddCookie(cookies[0])
	read.Header.Set("If-None-Match", receipt.BoardETag)
	readResponse := httptest.NewRecorder()
	browser.ServeHTTP(readResponse, read)
	if readResponse.Code != http.StatusNotModified {
		t.Fatalf("receipt validator rejected by board read: %d", readResponse.Code)
	}

	// A batch only needs the board once. A command that asks for a minimal
	// receipt must commit without paying for a board read it would discard.
	reads := repo.boardReads
	minimal := httptest.NewRequest("POST", root+"/changes", strings.NewReader(`{"kind":"item.rank","revision":1,"target":"a"}`))
	minimal.AddCookie(cookies[0])
	minimal.Header.Set("Content-Type", "application/json")
	minimal.Header.Set("X-CSRF-Token", csrf)
	minimal.Header.Set("Idempotency-Key", strings.Repeat("m", 20))
	minimal.Header.Set("Prefer", "return=minimal")
	minimalResponse := httptest.NewRecorder()
	changes := repo.changes
	browser.ServeHTTP(minimalResponse, minimal)
	if minimalResponse.Code != 200 {
		t.Fatalf("minimal change status %d: %s", minimalResponse.Code, minimalResponse.Body.String())
	}
	if repo.changes != changes+1 {
		t.Fatalf("minimal receipt did not commit the change: %d", repo.changes)
	}
	if repo.boardReads != reads {
		t.Fatalf("minimal receipt still read the board: %d reads", repo.boardReads-reads)
	}
	if applied := minimalResponse.Header().Get("Preference-Applied"); applied != "return=minimal" {
		t.Fatalf("preference not reported: %q", applied)
	}
	var lean struct {
		Revision  int64  `json:"revision"`
		BoardETag string `json:"board_etag"`
		Board     *Board `json:"board"`
	}
	if err = json.Unmarshal(minimalResponse.Body.Bytes(), &lean); err != nil {
		t.Fatal(err)
	}
	if lean.Revision != 2 || lean.Board != nil || lean.BoardETag != "" {
		t.Fatalf("minimal receipt carried a board: %s", minimalResponse.Body.String())
	}
}

// The preference is only honoured when the client actually asked for it.
func TestPreferMinimal(t *testing.T) {
	for _, testCase := range []struct {
		headers []string
		want    bool
	}{
		{headers: nil, want: false},
		{headers: []string{"return=minimal"}, want: true},
		{headers: []string{"  RETURN = Minimal "}, want: true},
		{headers: []string{`return="minimal"`}, want: true},
		{headers: []string{"wait=10, return=minimal"}, want: true},
		{headers: []string{"wait=10", "return=minimal"}, want: true},
		{headers: []string{"return=representation"}, want: false},
		{headers: []string{"return=minimalist"}, want: false},
		{headers: []string{"minimal"}, want: false},
	} {
		r := httptest.NewRequest("POST", "http://localhost/", nil)
		for _, header := range testCase.headers {
			r.Header.Add("Prefer", header)
		}
		if got := preferMinimal(r); got != testCase.want {
			t.Errorf("preferMinimal(%q) = %v, want %v", testCase.headers, got, testCase.want)
		}
	}
}

// Board reads report attachment presence as a count; metadata is a per-card read.
func TestItemAttachmentListing(t *testing.T) {
	manager, err := session.New(session.Config{SessionKey: []byte(strings.Repeat("s", 32)), CookiePrefix: "test"})
	if err != nil {
		t.Fatal(err)
	}
	login, _ := fluxauth.NewFixture(manager)
	loginResponse := httptest.NewRecorder()
	login.ServeHTTP(loginResponse, httptest.NewRequest("GET", "http://localhost/auth/login", nil))
	cookies := loginResponse.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("no session")
	}
	repo := &fakeRepository{attachment: Attachment{
		ID: 1, ItemID: "a", Name: "notes.txt", ContentType: "text/plain", Size: 3,
		Digest: "sha256:" + strings.Repeat("0", 64), Uploader: "u", StorageKey: "secret-key",
	}}
	h := NewHTTP(repo, manager, "machine-viewer", true, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	browser := manager.Gate(h.Handler(false))
	root := "http://localhost/api/v2/workspaces/w"

	list := httptest.NewRequest("GET", root+"/items/a/attachments", nil)
	list.AddCookie(cookies[0])
	listResponse := httptest.NewRecorder()
	browser.ServeHTTP(listResponse, list)
	if listResponse.Code != 200 {
		t.Fatalf("list status %d: %s", listResponse.Code, listResponse.Body.String())
	}
	var listed []Attachment
	if err = json.Unmarshal(listResponse.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].ID != 1 {
		t.Fatalf("unexpected listing: %s", listResponse.Body.String())
	}
	if strings.Contains(listResponse.Body.String(), "secret-key") {
		t.Fatal("storage key exposed to the browser")
	}
	blank := httptest.NewRequest("GET", root+"/items/%20/attachments", nil)
	blank.AddCookie(cookies[0])
	blankResponse := httptest.NewRecorder()
	browser.ServeHTTP(blankResponse, blank)
	if blankResponse.Code != 200 && blankResponse.Code != 400 {
		t.Fatalf("unexpected status for a padded item id: %d", blankResponse.Code)
	}
}

// A shared card link must open the current card whether it is active or
// archived, and must fail identically for a missing card and for a workspace
// the reader cannot enter.
func TestSharedItemLink(t *testing.T) {
	manager, err := session.New(session.Config{SessionKey: []byte(strings.Repeat("s", 32)), CookiePrefix: "test"})
	if err != nil {
		t.Fatal(err)
	}
	login, _ := fluxauth.NewFixture(manager)
	loginResponse := httptest.NewRecorder()
	login.ServeHTTP(loginResponse, httptest.NewRequest("GET", "http://localhost/auth/login", nil))
	cookies := loginResponse.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("no session")
	}
	repo := &fakeRepository{archived: []Item{{ID: "old", Title: "Old", ColumnID: "done", Revision: 4, Archived: true}}}
	h := NewHTTP(repo, manager, "machine-viewer", true, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	browser := manager.Gate(h.Handler(false))
	root := "http://localhost/api/v2/workspaces/w"
	read := func(path string) (*httptest.ResponseRecorder, ItemView) {
		t.Helper()
		request := httptest.NewRequest("GET", root+path, nil)
		request.AddCookie(cookies[0])
		response := httptest.NewRecorder()
		browser.ServeHTTP(response, request)
		var view ItemView
		_ = json.Unmarshal(response.Body.Bytes(), &view)
		return response, view
	}

	active, view := read("/items/a")
	if active.Code != 200 || view.Item.ID != "a" || view.Item.Archived || view.Revision != 1 || view.Role != "member" {
		t.Fatalf("active card: %d %s", active.Code, active.Body.String())
	}
	archived, archivedView := read("/items/old")
	if archived.Code != 200 || archivedView.Item.ID != "old" || !archivedView.Item.Archived {
		t.Fatalf("archived card: %d %s", archived.Code, archived.Body.String())
	}
	missing, _ := read("/items/nope")
	if missing.Code != 404 {
		t.Fatalf("missing card status %d", missing.Code)
	}
	repo.err = ErrForbidden
	forbidden, _ := read("/items/a")
	if forbidden.Code != 404 || forbidden.Body.String() != missing.Body.String() {
		t.Fatalf("non-member response leaks card existence: %d %s", forbidden.Code, forbidden.Body.String())
	}
}
