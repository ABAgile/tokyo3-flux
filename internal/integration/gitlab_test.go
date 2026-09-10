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
