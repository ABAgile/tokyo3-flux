package integration

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	p "abagile.com/tokyo3/flux/internal/planning"
)

func TestConfig(t *testing.T) {
	if c, err := New("", ""); c != nil || err != nil {
		t.Fatal(c, err)
	}
	for _, u := range []string{"", "file:///etc/passwd", "https://:443", "https://gitlab.example?", "https://gitlab.example:65536", "http://gitlab.example", "https://user:pass@gitlab.example", "https://gitlab.example/?token=secret", "https://gitlab.example/#fragment", "https://gitlab.example/a/../b", "https://gitlab.example/%2e%2e"} {
		if _, err := New(u, "secret"); err == nil {
			t.Fatal("accepted", u)
		}
	}
	if _, err := New("https://gitlab.example", ""); err == nil {
		t.Fatal("missing credential")
	}
	if _, err := New("https://gitlab.example", "bad\ntoken"); err == nil {
		t.Fatal("multiline token")
	}
	c, err := New("https://gitlab.example/gitlab/", "secret")
	if err != nil || c.Instance() != "https://gitlab.example/gitlab" {
		t.Fatal(c, err)
	}
	if c.safeURL("javascript:alert(1)") != "" || c.safeURL("https://other.example/gitlab/x") != "" || c.safeURL("https://gitlab.example/gitlab/x") == "" {
		t.Fatal("unsafe navigation URL")
	}
}
func TestProfileAvatarURL(t *testing.T) {
	c, err := New("https://gitlab.example", "server-secret")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := c.safeAvatarURL("https://secure.gravatar.com/avatar/0123456789abcdef0123456789abcdef?s=80"), "https://secure.gravatar.com/avatar/0123456789abcdef0123456789abcdef"; got != want {
		t.Fatalf("safeAvatarURL() = %q, want %q", got, want)
	}
	if got, want := c.safeAvatarURL("https://gitlab.example/uploads/avatar.png"), "https://gitlab.example/uploads/avatar.png"; got != want {
		t.Fatalf("same-host safeAvatarURL() = %q, want %q", got, want)
	}
	if got := c.safeAvatarURL("https://avatars.gravatar.com/avatar/0123456789abcdef0123456789abcdef"); got != "" {
		t.Fatalf("safeAvatarURL() accepted untrusted host %q", got)
	}
}

func TestMemberProfiles(t *testing.T) {
	var calls atomic.Int32
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/v4/users" || r.Header.Get("PRIVATE-TOKEN") != "server-secret" {
			t.Fatalf("profile request = %s %q", r.URL, r.Header.Get("PRIVATE-TOKEN"))
		}
		if got := r.URL.Query()["user_ids[]"]; len(got) != 2 || got[0] != "42" || got[1] != "7" {
			t.Fatalf("user IDs = %v", got)
		}
		_, _ = w.Write([]byte(`[{"id":42,"username":"alex","name":"Alex Example","avatar_url":"` + server.URL + `/uploads/alex.png"}]`))
	}))
	defer server.Close()
	c, err := New(server.URL, "server-secret")
	if err != nil {
		t.Fatal(err)
	}
	profiles := c.Profiles(context.Background(), []string{"42", "7", "fixture-user", "42"})
	if profiles["42"].Name != "Alex Example" || profiles["42"].AvatarURL != server.URL+"/uploads/alex.png" || len(profiles) != 1 {
		t.Fatalf("profiles = %+v", profiles)
	}
	if cached := c.Profiles(context.Background(), []string{"42"}); cached["42"].Name != "Alex Example" || calls.Load() != 1 {
		t.Fatalf("profile cache = %+v, calls = %d", cached, calls.Load())
	}
}

func TestProjects(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/v4/projects" || r.Header.Get("PRIVATE-TOKEN") != "server-secret" {
			t.Fatalf("project request = %s %q", r.URL, r.Header.Get("PRIVATE-TOKEN"))
		}
		query := r.URL.Query()
		for key, want := range map[string]string{"membership": "true", "simple": "true", "per_page": "100", "order_by": "name", "sort": "asc"} {
			if query.Get(key) != want {
				t.Fatalf("%s query = %q, want %q", key, query.Get(key), want)
			}
		}
		page := query.Get("page")
		if page == "1" {
			w.Header().Set("X-Next-Page", "2")
			_, _ = w.Write([]byte(`[{"id":42,"name":"Flux","path_with_namespace":"team/flux"}]`))
			return
		}
		if page != "2" {
			t.Fatalf("page = %q", page)
		}
		_, _ = w.Write([]byte(`[{"id":7,"name":"Docs","path_with_namespace":"team/docs"}]`))
	}))
	defer server.Close()
	c, err := New(server.URL, "server-secret")
	if err != nil {
		t.Fatal(err)
	}
	projects, err := c.Projects(context.Background())
	if err != nil || len(projects) != 2 || projects[0].ID != 42 || projects[1].PathWithNamespace != "team/docs" {
		t.Fatalf("projects = %+v, err = %v", projects, err)
	}
	if _, err = c.Projects(context.Background()); err != nil || calls.Load() != 2 {
		t.Fatalf("project cache calls = %d, err = %v", calls.Load(), err)
	}
}

func TestMergeRequests(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v4/projects/42/merge_requests" || r.Header.Get("PRIVATE-TOKEN") != "server-secret" {
			t.Fatalf("merge-request request = %s %q", r.URL, r.Header.Get("PRIVATE-TOKEN"))
		}
		query := r.URL.Query()
		for key, want := range map[string]string{"state": "all", "order_by": "updated_at", "sort": "desc", "per_page": "50"} {
			if query.Get(key) != want {
				t.Fatalf("%s query = %q, want %q", key, query.Get(key), want)
			}
		}
		if assignee := query.Get("assignee_id"); assignee != "" && assignee != "42" && assignee != "43" {
			t.Fatalf("assignee query = %q", assignee)
		}
		if query.Get("search") == "latest" {
			if query.Get("in") != "title" || len(query["iids[]"]) != 0 {
				t.Fatalf("title search query = %v", query)
			}
		} else if query.Get("iids[]") == "7" {
			if query.Get("search") != "" || query.Get("in") != "" {
				t.Fatalf("IID search query = %v", query)
			}
		} else {
			t.Fatalf("unexpected search query = %v", query)
		}
		_, _ = w.Write([]byte(`[{"id":1007,"iid":7,"project_id":42,"title":"Latest change","state":"opened","draft":false,"updated_at":"2026-09-11T00:00:00Z"}]`))
	}))
	defer server.Close()
	c, err := New(server.URL, "server-secret")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		search    string
		assignees []int64
	}{{search: "latest"}, {search: "7"}, {search: "latest", assignees: []int64{42, 43}}} {
		mergeRequests, err := c.MergeRequests(context.Background(), 42, tc.search, tc.assignees...)
		if err != nil || len(mergeRequests) != 1 || mergeRequests[0].IID != 7 || mergeRequests[0].Title != "Latest change" {
			t.Fatalf("merge requests for %q = %+v, err = %v", tc.search, mergeRequests, err)
		}
	}
}

func TestObservations(t *testing.T) {
	for _, tc := range []struct {
		name, body, kind, want string
		current                bool
	}{
		{"current head", `{"id":10,"iid":3,"project_id":42,"state":"opened","draft":true,"detailed_merge_status":"not_approved","sha":"new","head_pipeline":{"id":77,"sha":"new","status":"success"}}`, "mr", "success", true},
		{"old success", `{"id":10,"iid":3,"project_id":42,"sha":"new","head_pipeline":{"id":77,"sha":"old","status":"success"}}`, "mr", "unknown", false},
		{"pinned", `{"id":3,"project_id":42,"sha":"old","status":"failed"}`, "pipeline", "failed", false},
		{"future status", `{"id":3,"project_id":42,"sha":"old","status":"future"}`, "pipeline", "unknown", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" || r.Header.Get("PRIVATE-TOKEN") != "server-secret" {
					t.Error("not a credentialed read")
				}
				if !strings.HasPrefix(r.URL.Path, "/api/v4/projects/42/") {
					t.Error(r.URL)
				}
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			c, err := New(server.URL, "server-secret")
			if err != nil {
				t.Fatal(err)
			}
			v := c.Fetch(context.Background(), p.LinkTarget{Project: 42, Kind: tc.kind, Number: 3})
			if v.Outcome != "ok" || v.Observation.Pipeline.State != tc.want || v.Observation.Pipeline.CurrentHead != tc.current {
				t.Fatalf("%+v %+v", v, v.Observation)
			}
		})
	}
}
func TestMRPipelineURL(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, `{"id":10,"iid":3,"project_id":42,"sha":"head","web_url":%q,"head_pipeline":{"id":77,"sha":"head","status":"success","web_url":%q}}`, server.URL+"/team/flux/-/merge_requests/3", server.URL+"/team/flux/-/pipelines/77")
	}))
	defer server.Close()
	c, err := New(server.URL, "server-secret")
	if err != nil {
		t.Fatal(err)
	}
	result := c.Fetch(context.Background(), p.LinkTarget{Project: 42, Kind: "mr", Number: 3})
	if result.Outcome != "ok" || result.Observation == nil || result.Observation.Pipeline == nil || result.Observation.URL != server.URL+"/team/flux/-/merge_requests/3" || result.Observation.Pipeline.URL != server.URL+"/team/flux/-/pipelines/77" {
		t.Fatalf("MR pipeline links = %+v", result)
	}
}
func TestProviderFailures(t *testing.T) {
	for _, tc := range []struct {
		code       int
		body, want string
	}{{403, "secret diagnostic", "inaccessible"}, {404, "", "not_found"}, {429, "", "rate_limited"}, {503, "", "unavailable"}, {200, "not json", "invalid_response"}, {200, strings.Repeat("x", (1<<20)+1), "invalid_response"}, {200, `{"id":2,"project_id":99}`, "invalid_response"}, {200, `{"id":99,"project_id":42}`, "invalid_response"}} {
		t.Run(fmt.Sprint(tc.code, len(tc.body)), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Retry-After", "120")
				w.WriteHeader(tc.code)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			c, _ := New(server.URL, "secret")
			v := c.Fetch(context.Background(), p.LinkTarget{Project: 42, Kind: "pipeline", Number: 2})
			if v.Outcome != tc.want || v.Observation != nil {
				t.Fatal(v)
			}
			if tc.code == 429 {
				v = c.Fetch(context.Background(), p.LinkTarget{Project: 42, Kind: "pipeline", Number: 3})
				if calls.Load() != 1 || v.RetryAfter < time.Minute {
					t.Fatal(v, calls.Load())
				}
			}
		})
	}
}
func TestNoRedirectOrArbitraryFetch(t *testing.T) {
	var leaked atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true) }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, http.StatusFound) }))
	defer source.Close()
	c, _ := New(source.URL, "secret")
	if v := c.Fetch(context.Background(), p.LinkTarget{Project: 42, Kind: "mr", Number: 2}); v.Outcome != "unavailable" || leaked.Load() {
		t.Fatal(v, leaked.Load())
	}
	if v := c.Fetch(context.Background(), p.LinkTarget{Project: 42, Kind: "../../secrets", Number: 2}); v.Outcome != "invalid" {
		t.Fatal(v)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if v := c.Fetch(ctx, p.LinkTarget{Project: 42, Kind: "mr", Number: 2}); v.Outcome != "unavailable" {
		t.Fatal(v)
	}
}
func TestConcurrencyAndRetryBounds(t *testing.T) {
	c, _ := New("https://gitlab.example", "secret")
	for range 4 {
		c.slots <- struct{}{}
	}
	if v := c.Fetch(context.Background(), p.LinkTarget{Project: 1, Kind: "mr", Number: 1}); v.Outcome != "busy" {
		t.Fatal(v)
	}
	for _, raw := range []string{"0", "-2", "invalid", "999999999999999999999999", time.Now().Add(-time.Hour).Format(http.TimeFormat), "999999"} {
		d := retryDelay(raw)
		if d < 30*time.Second || d > time.Hour {
			t.Fatal(raw, d)
		}
	}
}
