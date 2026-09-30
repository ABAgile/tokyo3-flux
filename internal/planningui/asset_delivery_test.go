package planningui

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestAssetEncoding(t *testing.T) {
	for _, tc := range []struct {
		header     string
		encoding   string
		acceptable bool
	}{
		{"", "", true},
		{"br", "", true},
		{"gzip", "gzip", true},
		{"br, GZip; q=0.5", "gzip", true},
		{"gzip;q=0", "", true},
		{"gzip;q=0, *;q=1", "", true},
		{"*;q=0.5", "gzip", true},
		{"gzip;q=bogus", "", true},
		{"gzip;q=NaN", "", true},
		{"gzip;q=2", "", true},
		{"gzip;q=-1", "", true},
		{"gzip;q=0.5, identity;q=1", "", true},
		{"gzip;q=1, identity;q=0.5", "gzip", true},
		{"gzip;q=0, identity;q=0", "", false},
		{"*;q=0", "", false},
		{"*;q=0, gzip;q=1", "gzip", true},
		{"*;q=0, identity;q=1", "", true},
	} {
		t.Run(tc.header, func(t *testing.T) {
			encoding, acceptable := assetEncoding(tc.header)
			if encoding != tc.encoding || acceptable != tc.acceptable {
				t.Fatalf("got %q, %v; want %q, %v", encoding, acceptable, tc.encoding, tc.acceptable)
			}
		})
	}
}

func TestCompressedAssets(t *testing.T) {
	h := Handler()
	for _, path := range Paths() {
		t.Run(path, func(t *testing.T) {
			request := func(method, encoding, etag, byteRange string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, path, nil)
				r.Header.Set("Accept-Encoding", encoding)
				if etag != "" {
					r.Header.Set("If-None-Match", etag)
				}
				if byteRange != "" {
					r.Header.Set("Range", byteRange)
				}
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				return w
			}
			identity := request("GET", "", "", "")
			compressed := request("GET", "gzip", "", "")
			if compressed.Code != http.StatusOK || compressed.Header().Get("Content-Encoding") != "gzip" {
				t.Fatalf("gzip response: %d %v", compressed.Code, compressed.Header())
			}
			if compressed.Header().Get("Vary") != "Accept-Encoding" || identity.Header().Get("Vary") != "Accept-Encoding" {
				t.Fatal("both encodings must vary by Accept-Encoding")
			}
			if compressed.Header().Get("Content-Type") != identity.Header().Get("Content-Type") {
				t.Fatal("compressed content lost its MIME type")
			}
			reader, err := gzip.NewReader(bytes.NewReader(compressed.Body.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
			if err := reader.Close(); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(decoded, identity.Body.Bytes()) {
				t.Fatal("gzip changes asset bytes")
			}
			etag := compressed.Header().Get("ETag")
			if etag == "" || etag == identity.Header().Get("ETag") {
				t.Fatal("encoding validators must differ")
			}
			repeat := request("GET", "gzip", etag, "")
			if repeat.Code != http.StatusNotModified || repeat.Body.Len() != 0 || repeat.Header().Get("Vary") != "Accept-Encoding" {
				t.Fatalf("gzip revalidation: %d %v", repeat.Code, repeat.Header())
			}
			crossEncoding := request("GET", "gzip", identity.Header().Get("ETag"), "")
			if crossEncoding.Code != http.StatusOK {
				t.Fatal("identity validator matched gzip")
			}
			head := request("HEAD", "gzip", "", "")
			if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") != strconv.Itoa(compressed.Body.Len()) {
				t.Fatalf("gzip HEAD: %d %v", head.Code, head.Header())
			}
			partial := request("GET", "gzip", "", "bytes=0-9")
			if partial.Code != http.StatusPartialContent || !bytes.Equal(partial.Body.Bytes(), compressed.Body.Bytes()[:10]) {
				t.Fatal("range must refer to compressed representation")
			}
			rejected := request("GET", "gzip;q=0, identity;q=0", "", "")
			if rejected.Code != http.StatusNotAcceptable {
				t.Fatalf("excluded encodings: %d", rejected.Code)
			}
			if strings.HasSuffix(path, ".js") || path == "/styles.css" {
				if compressed.Body.Len() >= identity.Body.Len() {
					t.Fatal("compression did not reduce asset size")
				}
			}
		})
	}
}

func TestShellPreloadsOnlyServedModules(t *testing.T) {
	w := httptest.NewRecorder()
	Handler().ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	shell := w.Body.String()
	var expected []string
	for _, path := range Paths() {
		if strings.HasSuffix(path, ".js") {
			expected = append(expected, path)
		}
	}
	var found []string
	for line := range strings.SplitSeq(shell, "\n") {
		if path, ok := strings.CutPrefix(strings.TrimSpace(line), `<link rel="modulepreload" href="`); ok {
			found = append(found, strings.TrimSuffix(path, `">`))
		}
	}
	if !slices.Equal(found, expected) {
		t.Fatalf("preloads %v; want %v", found, expected)
	}
	if strings.Index(shell, `rel="modulepreload"`) > strings.Index(shell, "</head>") {
		t.Fatal("preloads must be inside head")
	}
}
