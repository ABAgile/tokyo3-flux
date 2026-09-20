package planning

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"abagile.com/tokyo3/flux/internal/blobstore"
	"github.com/abagile/tokyo3-base/session"
)

// uploadRepository shapes the two decisions the upload handler depends on: the
// board preflight (role, item state) and the outcome of the record write. The
// happy path lives in TestHTTPAttachments; these cases cover the branches that
// must not leak a stored object.
type uploadRepository struct {
	*fakeRepository
	role        string
	archived    bool
	withoutItem bool
	addErr      error
	// replayKey simulates a repository that already holds this idempotency
	// receipt and returns the previously stored object instead of the new one.
	replayKey string
	offered   []string
}

func (u *uploadRepository) Board(ctx context.Context, workspace, subject string) (Board, error) {
	b, err := u.fakeRepository.Board(ctx, workspace, subject)
	if err != nil {
		return b, err
	}
	if u.role != "" {
		b.Role = u.role
	}
	switch {
	case u.withoutItem:
		b.Items = nil
	case u.archived:
		b.Items[0].Archived = true
	}
	return b, nil
}

func (u *uploadRepository) AddAttachment(ctx context.Context, workspace, subject, item, key, idempotency string, attachment Attachment) (Attachment, error) {
	u.offered = append(u.offered, key)
	if u.addErr != nil {
		return Attachment{}, u.addErr
	}
	if u.replayKey != "" {
		attachment.ID, attachment.ItemID = 1, item
		attachment.Uploader, attachment.StorageKey = subject, u.replayKey
		return attachment, nil
	}
	return u.fakeRepository.AddAttachment(ctx, workspace, subject, item, key, idempotency, attachment)
}

// uploadFixture wires a browser-authenticated handler over a local blobstore
// and returns the blobstore root so stored objects can be counted directly.
func uploadFixture(t *testing.T, repo Repository, maxBytes int64) (http.Handler, *http.Cookie, string, string) {
	t.Helper()
	manager, err := session.New(session.Config{SessionKey: []byte(strings.Repeat("u", 32)), CookiePrefix: "upload-test"})
	if err != nil {
		t.Fatal(err)
	}
	cookie := loginCookie(t, manager)
	var csrf string
	probe := httptest.NewRequest("GET", "http://localhost/", nil)
	probe.AddCookie(cookie)
	manager.Gate(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		csrf, err = manager.CSRFToken(r, "planning")
	})).ServeHTTP(httptest.NewRecorder(), probe)
	if err != nil || csrf == "" {
		t.Fatal("no csrf", err)
	}
	root := t.TempDir()
	blobs, err := blobstore.NewLocal(root, maxBytes)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { blobs.Close() })
	h := NewHTTP(repo, manager, "machine-viewer", true, slog.New(slog.NewTextHandler(io.Discard, nil)), blobs)
	return manager.Gate(h.Handler(false)), cookie, csrf, root
}

// storedBlobs counts committed objects. Interrupted writes use dot-prefixed
// temporary names and are excluded, so a leak is distinguishable from a retry.
func storedBlobs(t *testing.T, root string) []string {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), ".") {
			names = append(names, entry.Name())
		}
	}
	return names
}

type uploadPart struct{ field, filename, content string }

func uploadRequest(t *testing.T, cookie *http.Cookie, csrf, key string, parts []uploadPart) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, part := range parts {
		file, err := writer.CreateFormFile(part.field, part.filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte(part.content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "http://localhost/api/v2/workspaces/w/items/a/attachments", &body)
	request.AddCookie(cookie)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("X-CSRF-Token", csrf)
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	return request
}

func upload(t *testing.T, handler http.Handler, cookie *http.Cookie, csrf, key string, parts []uploadPart) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, uploadRequest(t, cookie, csrf, key, parts))
	return response
}

func onePart() []uploadPart {
	return []uploadPart{{field: "file", filename: "note.txt", content: "hello"}}
}

// A failed record write must not leave the uploaded bytes behind. Without the
// cleanup the blobstore accumulates objects no workspace can ever reference.
func TestUploadRemovesBlobWhenTheRecordFails(t *testing.T) {
	repo := &uploadRepository{fakeRepository: &fakeRepository{}, addErr: ErrConflict}
	handler, cookie, csrf, root := uploadFixture(t, repo, 1024)
	response := upload(t, handler, cookie, csrf, strings.Repeat("k", 16), onePart())
	if response.Code != http.StatusConflict {
		t.Fatalf("upload status %d: %s", response.Code, response.Body.String())
	}
	if blobs := storedBlobs(t, root); len(blobs) != 0 {
		t.Fatalf("failed upload leaked %d blobs: %v", len(blobs), blobs)
	}
	if len(repo.offered) != 1 {
		t.Fatalf("record writes = %d, want 1", len(repo.offered))
	}
}

// Replaying an idempotency key must return the stored attachment, report 200
// rather than 201, and discard the freshly written duplicate object.
func TestUploadReplayDiscardsTheDuplicateBlob(t *testing.T) {
	repo := &uploadRepository{fakeRepository: &fakeRepository{}}
	handler, cookie, csrf, root := uploadFixture(t, repo, 1024)
	key := strings.Repeat("k", 16)
	first := upload(t, handler, cookie, csrf, key, onePart())
	if first.Code != http.StatusCreated {
		t.Fatalf("first upload status %d: %s", first.Code, first.Body.String())
	}
	stored := storedBlobs(t, root)
	if len(stored) != 1 {
		t.Fatalf("first upload stored %d blobs: %v", len(stored), stored)
	}
	repo.replayKey = stored[0]
	second := upload(t, handler, cookie, csrf, key, onePart())
	if second.Code != http.StatusOK {
		t.Fatalf("replay status %d: %s", second.Code, second.Body.String())
	}
	if blobs := storedBlobs(t, root); len(blobs) != 1 || blobs[0] != stored[0] {
		t.Fatalf("replay changed stored blobs: %v, want %v", blobs, stored)
	}
	var replayed Attachment
	if err := json.NewDecoder(second.Body).Decode(&replayed); err != nil {
		t.Fatal(err)
	}
	if replayed.ID != 1 || replayed.StorageKey != "" {
		t.Fatalf("replay exposed storage details: %+v", replayed)
	}
}

// The preflight runs before any byte is stored, so a rejected upload must
// leave the blobstore empty whatever the reason.
func TestUploadPreflightRejectsWithoutStoringBytes(t *testing.T) {
	tests := []struct {
		name   string
		repo   *uploadRepository
		status int
	}{
		{"viewer", &uploadRepository{fakeRepository: &fakeRepository{}, role: "viewer"}, http.StatusForbidden},
		{"archived item", &uploadRepository{fakeRepository: &fakeRepository{}, archived: true}, http.StatusBadRequest},
		{"unknown item", &uploadRepository{fakeRepository: &fakeRepository{}, withoutItem: true}, http.StatusNotFound},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			handler, cookie, csrf, root := uploadFixture(t, tc.repo, 1024)
			response := upload(t, handler, cookie, csrf, strings.Repeat("k", 16), onePart())
			if response.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", response.Code, tc.status, response.Body.String())
			}
			if blobs := storedBlobs(t, root); len(blobs) != 0 {
				t.Fatalf("rejected upload stored %d blobs: %v", len(blobs), blobs)
			}
			if len(tc.repo.offered) != 0 {
				t.Fatal("rejected upload reached the record write")
			}
		})
	}
}

// The handler accepts exactly one file in the "file" field. Anything else is a
// client error, not a partially stored attachment.
func TestUploadRejectsMalformedMultipart(t *testing.T) {
	tests := []struct {
		name  string
		key   string
		parts []uploadPart
	}{
		{"no file part", strings.Repeat("k", 16), []uploadPart{{field: "other", filename: "note.txt", content: "hello"}}},
		{"two file parts", strings.Repeat("k", 16), []uploadPart{
			{field: "file", filename: "one.txt", content: "one"},
			{field: "file", filename: "two.txt", content: "two"},
		}},
		{"empty filename", strings.Repeat("k", 16), []uploadPart{{field: "file", filename: "", content: "hello"}}},
		{"short idempotency key", "tooshort", onePart()},
		{"missing idempotency key", "", onePart()},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			repo := &uploadRepository{fakeRepository: &fakeRepository{}}
			handler, cookie, csrf, root := uploadFixture(t, repo, 1024)
			response := upload(t, handler, cookie, csrf, tc.key, tc.parts)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status %d, want 400: %s", response.Code, response.Body.String())
			}
			if blobs := storedBlobs(t, root); len(blobs) != 0 {
				t.Fatalf("rejected upload stored %d blobs: %v", len(blobs), blobs)
			}
			if len(repo.offered) != 0 {
				t.Fatal("rejected upload reached the record write")
			}
		})
	}
}

// A file past the blobstore limit is refused as a client error, and the
// partial write is not committed.
func TestUploadRejectsOversizeFile(t *testing.T) {
	repo := &uploadRepository{fakeRepository: &fakeRepository{}}
	handler, cookie, csrf, root := uploadFixture(t, repo, 8)
	parts := []uploadPart{{field: "file", filename: "note.txt", content: strings.Repeat("x", 64)}}
	response := upload(t, handler, cookie, csrf, strings.Repeat("k", 16), parts)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400: %s", response.Code, response.Body.String())
	}
	if blobs := storedBlobs(t, root); len(blobs) != 0 {
		t.Fatalf("oversize upload stored %d blobs: %v", len(blobs), blobs)
	}
	if len(repo.offered) != 0 {
		t.Fatal("oversize upload reached the record write")
	}
}

// Without a configured blobstore the route reports storage as unavailable
// instead of failing later with a generic error.
func TestUploadWithoutBlobstoreIsUnavailable(t *testing.T) {
	manager, err := session.New(session.Config{SessionKey: []byte(strings.Repeat("u", 32)), CookiePrefix: "upload-test"})
	if err != nil {
		t.Fatal(err)
	}
	cookie := loginCookie(t, manager)
	var csrf string
	probe := httptest.NewRequest("GET", "http://localhost/", nil)
	probe.AddCookie(cookie)
	manager.Gate(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		csrf, err = manager.CSRFToken(r, "planning")
	})).ServeHTTP(httptest.NewRecorder(), probe)
	if err != nil || csrf == "" {
		t.Fatal("no csrf", err)
	}
	h := NewHTTP(&fakeRepository{}, manager, "machine-viewer", true, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	response := upload(t, manager.Gate(h.Handler(false)), cookie, csrf, strings.Repeat("k", 16), onePart())
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503: %s", response.Code, response.Body.String())
	}
	var failure struct {
		Error string `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&failure); err != nil {
		t.Fatal(err)
	}
	if failure.Error != ErrAttachmentUnavailable.Error() {
		t.Fatalf("unexpected failure message %q", failure.Error)
	}
}
