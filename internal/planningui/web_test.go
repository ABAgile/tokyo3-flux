package planningui

import (
	"bytes"
	"io/fs"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNativeAssets(t *testing.T) {
	h := Handler()
	for _, path := range []string{"/", "/app.js", "/styles.css",
		"/modules/dom.js", "/modules/api.js", "/modules/format.js", "/modules/markdown.js"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || w.Body.Len() == 0 {
			t.Fatalf("%s: %d", path, w.Code)
		}
		if path == "/" && !strings.Contains(w.Body.String(), "Sprint") {
			t.Fatal("planning shell missing")
		}
	}
	for _, path := range []string{"/missing", "/static/", "/index.html",
		"/modules/", "/modules/missing.js", "/modules/nested/dom.js", "/modules/../app.js", "/modules/dom.css",
		"/styles/", "/styles/010-tokens.css"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 404 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/", nil))
	if w.Code != 405 {
		t.Fatal("write accepted")
	}
}

func TestStylesheetJoinsFeatureFiles(t *testing.T) {
	names, err := fs.Glob(files, "static/styles/*.css")
	if err != nil || len(names) < 2 {
		t.Fatalf("feature stylesheets: %v %v", names, err)
	}
	var want []byte
	for _, name := range names { // Glob returns names in lexical order.
		content, err := fs.ReadFile(files, name)
		if err != nil {
			t.Fatal(err)
		}
		want = append(want, content...)
	}
	w := httptest.NewRecorder()
	Handler().ServeHTTP(w, httptest.NewRequest("GET", "/styles.css", nil))
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), want) {
		t.Fatalf("/styles.css: %d, %d bytes, want the %d joined bytes", w.Code, w.Body.Len(), len(want))
	}
	if got := w.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/css") {
		t.Fatalf("/styles.css content type %q", got)
	}
	if !strings.HasPrefix(names[0], "static/styles/010-tokens") {
		t.Fatalf("tokens must load first, got %s", names[0])
	}
}

func TestAssetRevalidation(t *testing.T) {
	h := Handler()
	for _, path := range []string{"/", "/app.js", "/styles.css", "/modules/api.js"} {
		first := httptest.NewRecorder()
		h.ServeHTTP(first, httptest.NewRequest("GET", path, nil))
		etag := first.Header().Get("ETag")
		if first.Code != 200 || etag == "" {
			t.Fatalf("%s: %d etag %q", path, first.Code, etag)
		}
		if control := first.Header().Get("Cache-Control"); control != "no-cache" {
			t.Fatalf("%s: cache control %q", path, control)
		}
		request := httptest.NewRequest("GET", path, nil)
		request.Header.Set("If-None-Match", etag)
		repeat := httptest.NewRecorder()
		h.ServeHTTP(repeat, request)
		if repeat.Code != 304 || repeat.Body.Len() != 0 {
			t.Fatalf("%s resent: %d body %d", path, repeat.Code, repeat.Body.Len())
		}
	}
	// Distinct assets must not share a validator.
	shell := httptest.NewRecorder()
	h.ServeHTTP(shell, httptest.NewRequest("GET", "/", nil))
	styles := httptest.NewRecorder()
	h.ServeHTTP(styles, httptest.NewRequest("GET", "/styles.css", nil))
	if shell.Header().Get("ETag") == styles.Header().Get("ETag") {
		t.Fatal("assets share an ETag")
	}
}
