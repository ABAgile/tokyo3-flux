// Package web serves Flux's embedded browser cockpit.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed static/*
var assets embed.FS

// NewHandler returns the browser handler. API and health paths are delegated to
// apiHandler; every other path is served from the embedded cockpit assets.
func NewHandler(apiHandler http.Handler) http.Handler {
	staticFS, err := fs.Sub(assets, "static")
	if err != nil {
		panic("flux web: embedded static files are unavailable")
	}
	staticHandler := http.FileServer(http.FS(staticFS))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isAPIPath(r.URL.Path) {
			apiHandler.ServeHTTP(w, r)
			return
		}
		staticHandler.ServeHTTP(w, r)
	})
}

func isAPIPath(path string) bool {
	return path == "/healthz" ||
		path == "/readyz" ||
		path == "/webhooks/gitlab" ||
		strings.HasPrefix(path, "/api/")
}
