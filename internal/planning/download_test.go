package planning

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	fluxauth "abagile.com/tokyo3/flux/internal/auth"
	"abagile.com/tokyo3/flux/internal/blobstore"
	"github.com/abagile/tokyo3-base/session"
)

func loginCookie(t *testing.T, manager *session.Manager) *http.Cookie {
	t.Helper()
	login, err := fluxauth.NewFixture(manager)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	login.ServeHTTP(recorder, httptest.NewRequest("GET", "http://localhost/auth/login", nil))
	cookies := recorder.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("fixture login issued no session cookie")
	}
	return cookies[0]
}

// downloadFixture wires a browser-authenticated handler over a local blobstore
// holding a single attachment of the requested size.
func downloadFixture(t *testing.T, size int) (http.Handler, *http.Cookie, string, []byte) {
	t.Helper()
	manager, err := session.New(session.Config{SessionKey: []byte(strings.Repeat("s", 32)), CookiePrefix: "test"})
	if err != nil {
		t.Fatal(err)
	}
	cookie := loginCookie(t, manager)
	root := t.TempDir()
	blobs, err := blobstore.NewLocal(root, MaxAttachmentBytes)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { blobs.Close() })
	payload := bytes.Repeat([]byte("flux"), size/4)
	key := NewID()
	info, err := blobs.Put(t.Context(), key, bytes.NewReader(payload), "application/octet-stream")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	if info.Digest != "sha256:"+hex.EncodeToString(digest[:]) {
		t.Fatalf("unexpected stored digest %q", info.Digest)
	}
	repo := &fakeRepository{attachment: Attachment{
		ID: 1, ItemID: "a", Name: "payload.bin", ContentType: "application/octet-stream",
		Size: int64(len(payload)), Digest: info.Digest, Uploader: "fixture", StorageKey: key,
	}}
	h := NewHTTP(repo, manager, "machine-viewer", true, slog.New(slog.NewTextHandler(io.Discard, nil)), blobs)
	return manager.Gate(h.Handler(false)), cookie, filepath.Join(root, key), payload
}

func downloadRequest(t *testing.T, handler http.Handler, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest("GET", "http://localhost/api/v2/workspaces/w/items/a/attachments/1", nil)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

// A streamed attachment is read once; the digest is checked as it is written.
func TestStreamedAttachmentDownloadServesVerifiedBytes(t *testing.T) {
	handler, cookie, _, payload := downloadFixture(t, MaxBufferedAttachmentBytes+4)
	response := downloadRequest(t, handler, cookie)
	if response.Code != http.StatusOK {
		t.Fatalf("download status %d: %s", response.Code, response.Body.String())
	}
	if !bytes.Equal(response.Body.Bytes(), payload) {
		t.Fatalf("streamed body differs: %d bytes", response.Body.Len())
	}
}

// Above the buffering threshold the response is already committed, so a corrupt
// object must abort the connection rather than look like a complete download.
func TestStreamedAttachmentDownloadAbortsOnCorruption(t *testing.T) {
	handler, cookie, path, payload := downloadFixture(t, MaxBufferedAttachmentBytes+4)
	corrupt := append([]byte(nil), payload...)
	corrupt[0] ^= 0xff
	if err := os.WriteFile(path, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if recovered := recover(); recovered != http.ErrAbortHandler {
			t.Fatalf("corrupt stream did not abort the response: %v", recovered)
		}
	}()
	downloadRequest(t, handler, cookie)
}

// Below the threshold the object is verified in memory, so corruption still
// produces a clean error response.
func TestBufferedAttachmentDownloadRejectsCorruption(t *testing.T) {
	handler, cookie, path, payload := downloadFixture(t, 64)
	corrupt := append([]byte(nil), payload...)
	corrupt[0] ^= 0xff
	if err := os.WriteFile(path, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}
	response := downloadRequest(t, handler, cookie)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("corrupt download status %d: %s", response.Code, response.Body.String())
	}
}

// Every response carries one correlation identifier, and it is stable for the
// request rather than regenerated per log line.
func TestRequestIDIsAssignedPerRequest(t *testing.T) {
	handler, cookie, _, _ := downloadFixture(t, 64)
	first := downloadRequest(t, handler, cookie).Header().Get("X-Request-Id")
	second := downloadRequest(t, handler, cookie).Header().Get("X-Request-Id")
	if first == "" || second == "" {
		t.Fatalf("missing request identifier: %q %q", first, second)
	}
	if first == second {
		t.Fatalf("request identifier repeated across requests: %q", first)
	}
	denied := httptest.NewRequest("GET", "http://localhost/api/v2/workspaces/w/board", nil)
	deniedResponse := httptest.NewRecorder()
	handler.ServeHTTP(deniedResponse, denied)
	if deniedResponse.Header().Get("X-Request-Id") != "" && deniedResponse.Code == http.StatusOK {
		t.Fatal("unauthenticated request was served")
	}
}
