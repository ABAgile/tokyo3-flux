// Package planningui serves the native, database-backed planning workspace.
package planningui

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed static/*
var files embed.FS

func Handler() http.Handler {
	root, err := fs.Sub(files, "static")
	if err != nil {
		panic(err)
	}
	server := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !servedAsset(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		server.ServeHTTP(w, r)
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
