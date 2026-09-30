// Package planningui serves the native, database-backed planning workspace.
package planningui

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"
)

//go:embed static/*
var files embed.FS

// asset is a build artifact: its bytes are fixed for the life of the binary,
// so it carries a content ETag and is revalidated instead of refetched.
type asset struct {
	content     []byte
	etag        string
	gzipContent []byte
	gzipETag    string
	name        string
}

var assets = loadAssets()

func assetETag(content []byte) string {
	sum := sha256.Sum256(content)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

func newAsset(name string, content []byte) asset {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(content); err != nil {
		panic(err)
	}
	if err := writer.Close(); err != nil {
		panic(err)
	}
	return asset{content: content, etag: assetETag(content),
		gzipContent: compressed.Bytes(), gzipETag: assetETag(compressed.Bytes()), name: name}
}

// loadAssets indexes the embedded files by URL path. The stylesheet is authored
// as ordered feature files under static/styles/ and served as the single
// /styles.css asset, joined in name order, so the page keeps one <link> and
// the individual files are never reachable.
func loadAssets() map[string]asset {
	root, err := fs.Sub(files, "static")
	if err != nil {
		panic(err)
	}
	out := map[string]asset{}
	var styles []byte
	// WalkDir visits entries in lexical order, which fixes the join order.
	err = fs.WalkDir(root, ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		content, readErr := fs.ReadFile(root, name)
		if readErr != nil {
			return readErr
		}
		if path.Dir(name) == "styles" && path.Ext(name) == ".css" {
			styles = append(styles, content...)
			return nil
		}
		value := newAsset(path.Base(name), content)
		out["/"+name] = value
		if name == "index.html" {
			out["/"] = value
		}
		return nil
	})
	if err != nil {
		panic(err)
	}
	if len(styles) == 0 {
		panic("planningui: no stylesheets under static/styles")
	}
	out["/styles.css"] = newAsset("styles.css", styles)
	// Discover the whole same-origin module graph without serial import requests.
	var preload strings.Builder
	for _, name := range assetPaths(out) {
		if strings.HasSuffix(name, ".js") {
			preload.WriteString(`  <link rel="modulepreload" href="`)
			preload.WriteString(name)
			preload.WriteString("\">\n")
		}
	}
	shell := bytes.Replace(out["/"].content, []byte("</head>"), []byte(preload.String()+"</head>"), 1)
	out["/"] = newAsset("index.html", shell)
	return out
}

// Paths lists every browser-reachable asset path, sorted. The shell loads one
// request per ES module and every asset is served from memory, so the server
// exempts exactly these paths from per-client request limits.
func Paths() []string { return assetPaths(assets) }

func assetPaths(index map[string]asset) []string {
	out := make([]string, 0, len(index))
	for name := range index {
		if servedAsset(name) {
			out = append(out, name)
		}
	}
	slices.Sort(out)
	return out
}

func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		file, ok := assets[r.URL.Path]
		if !servedAsset(r.URL.Path) || !ok {
			http.NotFound(w, r)
			return
		}
		// The shell must not outlive a deployment, so it is revalidated on every
		// load rather than stored for a fixed lifetime. An unchanged build then
		// answers with an empty 304 instead of the whole module graph.
		w.Header().Set("Vary", "Accept-Encoding")
		encoding, acceptable := assetEncoding(strings.Join(r.Header.Values("Accept-Encoding"), ","))
		if !acceptable {
			http.Error(w, "no acceptable asset encoding", http.StatusNotAcceptable)
			return
		}
		content, etag := file.content, file.etag
		if encoding == "gzip" {
			content, etag = file.gzipContent, file.gzipETag
			w.Header().Set("Content-Encoding", "gzip")
		}
		contentType := mime.TypeByExtension(path.Ext(file.name))
		if contentType == "" {
			contentType = http.DetectContentType(file.content)
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("ETag", etag)
		http.ServeContent(w, r, file.name, time.Time{}, bytes.NewReader(content))
	})
}

// assetEncoding honors explicit refusals and wildcard quality values. Prefer
// compression when identity has no explicit preference; an absent header keeps
// the original uncompressed response.
func assetEncoding(header string) (string, bool) {
	qualities := map[string]float64{}
	for entry := range strings.SplitSeq(header, ",") {
		name, parameters, _ := strings.Cut(strings.TrimSpace(entry), ";")
		quality := 1.0
		for parameter := range strings.SplitSeq(parameters, ";") {
			key, value, _ := strings.Cut(strings.TrimSpace(parameter), "=")
			if strings.EqualFold(key, "q") {
				parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
				if err != nil || !(parsed >= 0 && parsed <= 1) {
					quality = 0
				} else {
					quality = parsed
				}
			}
		}
		qualities[strings.ToLower(strings.TrimSpace(name))] = quality
	}
	gzipQuality, explicitGzip := qualities["gzip"]
	wildcard, hasWildcard := qualities["*"]
	if !explicitGzip && hasWildcard {
		gzipQuality = wildcard
	}
	identityQuality, explicitIdentity := qualities["identity"]
	if !explicitIdentity {
		identityQuality = 1
		if hasWildcard && wildcard == 0 {
			identityQuality = 0
		}
	}
	if gzipQuality > 0 && (!explicitIdentity || gzipQuality >= identityQuality) {
		return "gzip", true
	}
	return "", identityQuality > 0
}

// servedAsset is the exact allowlist of browser-reachable paths. The shell is
// an ES module, so its imports under /modules/ must be reachable too; only
// single-segment .js names are accepted, which keeps directory listings and
// traversal attempts out of the file server.
func servedAsset(path string) bool {
	switch path {
	case "/", "/app.js", "/styles.css":
		return true
	}
	name, ok := strings.CutPrefix(path, "/modules/")
	return ok && name != "" && strings.HasSuffix(name, ".js") &&
		!strings.ContainsAny(name, "/\\") && !strings.Contains(name, "..")
}
