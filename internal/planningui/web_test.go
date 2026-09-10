package planningui

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNativeAssets(t *testing.T) {
	h := Handler()
	for _, path := range []string{"/", "/app.js", "/styles.css"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || w.Body.Len() == 0 {
			t.Fatalf("%s: %d", path, w.Code)
		}
		if path == "/" && !strings.Contains(w.Body.String(), "Sprint") {
			t.Fatal("planning shell missing")
		}
	}
	for _, path := range []string{"/missing", "/static/", "/index.html"} {
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
