package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

func TestNativeCLIReadsAndDryRun(t *testing.T) {
	b := p.Board{Workspace: p.Workspace{ID: "w", Revision: 1}, Role: "viewer", Columns: []p.Column{{ID: "ready", Name: "Ready", Category: "todo"}}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer fixture-token" || !strings.HasPrefix(r.URL.Path, "/api/v2/workspaces/w/") {
			t.Error("unexpected request", r.Method, r.URL.Path)
			w.WriteHeader(403)
			return
		}
		_ = json.NewEncoder(w).Encode(b)
	}))
	defer server.Close()
	t.Setenv("FLUX_API_URL", server.URL)
	t.Setenv("FLUX_API_TOKEN", "fixture-token")
	var out, errout bytes.Buffer
	if err := run([]string{"read", "--workspace", "w"}, &out, &errout); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	snapshot := filepath.Join(dir, "snapshot.json")
	mapping := filepath.Join(dir, "mapping.json")
	if err := os.WriteFile(snapshot, []byte(`{"sprint":{"work_items":[{"id":"#7","project_id":42,"title":"Imported"}]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mapping, []byte(`{"instance":"https://gitlab.example","records":[{"snapshot_id":"#7","gitlab_project_id":42,"issue_iid":7,"item":{"column_id":"ready","priority":"normal"}}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := run([]string{"import", "--workspace", "w", "--input", snapshot, "--mapping", mapping}, &out, &errout); err != nil {
		t.Fatal(err)
	}
	var report p.ImportReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil || report.Document == nil || report.WouldCreate != 1 || report.AlreadyImported != 0 {
		t.Fatal(report, err)
	}
	for _, args := range [][]string{{"today"}, {"serve", "--fixture", "snapshot.json"}, {"serve", "--gitlab-group", "team"}} {
		if err := run(args, &out, &errout); err == nil {
			t.Fatal("retired command accepted", args)
		}
	}
}
func TestNativeClientDoesNotFollowRedirects(t *testing.T) {
	calls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer server.Close()
	t.Setenv("FLUX_API_TOKEN", "private-fixture-token")
	t.Setenv("FLUX_API_URL", server.URL)
	if _, err := fetchNative("/api/v2/workspaces/w/read/board"); err == nil || strings.Contains(err.Error(), "private-fixture-token") {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatal("redirect forwarded token")
	}
	for _, url := range []string{"http://remote.example", "https://user:password@host", "https://host/path", "https://host?token=x"} {
		t.Setenv("FLUX_API_URL", url)
		if _, err := fetchNative("/api/v2/workspaces/w/read/board"); err == nil {
			t.Fatal(url)
		}
	}
}
