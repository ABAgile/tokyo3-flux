// Package planningui serves the native, database-backed planning workspace.
package planningui

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed static/*
var files embed.FS

// asset is a build artifact: its bytes are fixed for the life of the binary,
// so it carries a content ETag and is revalidated instead of refetched.
type asset struct {
	content []byte
	etag    string
	name    string
}

var assets = loadAssets()

func loadAssets() map[string]asset {
	root, err := fs.Sub(files, "static")
	if err != nil {
		panic(err)
	}
	out := map[string]asset{}
	err = fs.WalkDir(root, ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		content, readErr := fs.ReadFile(root, name)
		if readErr != nil {
			return readErr
		}
		sum := sha256.Sum256(content)
		value := asset{content: content, etag: `"` + hex.EncodeToString(sum[:]) + `"`, name: path.Base(name)}
		out["/"+name] = value
		if name == "index.html" {
			out["/"] = value
		}
		return nil
	})
	if err != nil {
		panic(err)
	}
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
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("ETag", file.etag)
		http.ServeContent(w, r, file.name, time.Time{}, bytes.NewReader(file.content))
	})
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
