package store

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/integration"
	p "abagile.com/tokyo3/flux/internal/planning"
)

const observedMR = `{"id":100,"iid":7,"project_id":42,"state":"opened","sha":"head","head_pipeline":{"id":33,"sha":"head","status":"success"}}`

func linkedBoard(t *testing.T, handler http.HandlerFunc) (*Store, p.Board) {
	t.Helper()
	s := testStore(t)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	c, err := integration.New(server.URL, "server-only-secret")
	if err != nil {
		t.Fatal(err)
	}
	s.SetConnector(c)
	b := bootstrap(t, s)
	apply(t, s, &b, p.Command{Kind: "integration.save", Integration: &p.Integration{Instance: c.Instance(), Projects: []int64{42}}})
	it := newItem(b, "Linked work")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &it})
	apply(t, s, &b, p.Command{Kind: "link.attach", Target: b.Items[0].ID, Link: &p.LinkTarget{Project: 42, Kind: "mr", Number: 7}})
	return s, b
}
func TestGitLabProjectCatalog(t *testing.T) {
	s := testStore(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v4/projects":
			_, _ = w.Write([]byte(`[{"id":42,"name":"Flux","path_with_namespace":"team/flux"}]`))
		case "/api/v4/projects/42/merge_requests":
			if assignee := r.URL.Query().Get("assignee_id"); assignee != "" && assignee != "42" {
				t.Fatalf("GitLab assignee = %s", assignee)
			}
			_, _ = w.Write([]byte(`[{"id":1007,"iid":7,"project_id":42,"title":"Latest change","state":"opened"}]`))
		default:
			t.Fatalf("GitLab path = %s", r.URL.Path)
		}
	}))
	defer server.Close()
	connector, err := integration.New(server.URL, "server-only-secret")
	if err != nil {
		t.Fatal(err)
	}
	s.SetConnector(connector)
	b := bootstrap(t, s)
	projects, err := s.GitLabProjects(context.Background(), b.Workspace.ID, "alice")
	if err != nil || len(projects) != 1 || projects[0].ID != 42 || projects[0].PathWithNamespace != "team/flux" {
		t.Fatalf("projects = %+v, err = %v", projects, err)
	}
	apply(t, s, &b, p.Command{Kind: "integration.save", Integration: &p.Integration{Instance: connector.Instance(), Projects: []int64{42}}})
	mergeRequests, err := s.GitLabMergeRequestsFor(context.Background(), b.Workspace.ID, "alice", 42, "latest", "recent")
	if err != nil || len(mergeRequests) != 1 || mergeRequests[0].IID != 7 || mergeRequests[0].Title != "Latest change" {
		t.Fatalf("merge requests = %+v, err = %v", mergeRequests, err)
	}
	if err := s.SetMember(context.Background(), b.Workspace.ID, "42", "member"); err != nil {
		t.Fatal(err)
	}
	assigned, err := s.GitLabMergeRequestsFor(context.Background(), b.Workspace.ID, "42", 42, "latest", "assigned_to_me")
	if err != nil || len(assigned) != 1 || assigned[0].IID != 7 {
		t.Fatalf("assigned merge requests = %+v, err = %v", assigned, err)
	}
	boardMembers, err := s.GitLabMergeRequestsFor(context.Background(), b.Workspace.ID, "alice", 42, "latest", "board_members")
	if err != nil || len(boardMembers) != 1 || boardMembers[0].IID != 7 {
		t.Fatalf("board-member merge requests = %+v, err = %v", boardMembers, err)
	}
	if err := s.SetMember(context.Background(), b.Workspace.ID, "viewer", "viewer"); err != nil {
		t.Fatal(err)
	}
	viewerProjects, err := s.GitLabProjects(context.Background(), b.Workspace.ID, "viewer")
	if err != nil || len(viewerProjects) != 1 || viewerProjects[0].ID != 42 {
		t.Fatalf("viewer catalog access = %+v, err = %v", viewerProjects, err)
	}
	if _, err := s.GitLabMergeRequestsFor(context.Background(), b.Workspace.ID, "viewer", 42, "latest", "recent"); !errors.Is(err, p.ErrForbidden) {
		t.Fatalf("viewer merge-request search = %v", err)
	}
}

func expireLink(t *testing.T, s *Store, b p.Board) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(), "UPDATE external_links SET next_refresh=now()-interval '1 second' WHERE workspace_id=$1", b.Workspace.ID); err != nil {
		t.Fatal(err)
	}
}
func refreshCommand(b p.Board) p.Command {
	return p.Command{Kind: "link.refresh", Target: b.Links[0].ID, Revision: b.Workspace.Revision}
}
func TestExternalPersistenceAndRefresh(t *testing.T) {
	var calls atomic.Int32
	var unavailable atomic.Bool
	s, b := linkedBoard(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if unavailable.Load() {
			w.WriteHeader(503)
			return
		}
		_, _ = w.Write([]byte(observedMR))
	})
	ctx := context.Background()
	key := p.NewID()
	cmd := refreshCommand(b)
	before := b.Items[0]
	if _, err := s.Change(ctx, b.Workspace.ID, "alice", key, cmd); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Change(ctx, b.Workspace.ID, "alice", key, cmd); err != nil {
		t.Fatal(err)
	}
	next := getBoard(t, s, b.Workspace.ID)
	if calls.Load() != 1 || next.Workspace.Revision != b.Workspace.Revision || next.Items[0].Revision != before.Revision || next.Items[0].ColumnID != before.ColumnID || next.Links[0].Observation.Pipeline.State != "success" || next.Links[0].LastSuccess == nil {
		t.Fatal(next, calls.Load())
	}
	if _, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), cmd); !errors.Is(err, p.ErrConflict) {
		t.Fatal("cooldown", err)
	}
	if _, err := s.Change(ctx, b.Workspace.ID, "alice", key, p.Command{Kind: "item.archive", Target: b.Items[0].ID, Revision: cmd.Revision}); !errors.Is(err, p.ErrConflict) {
		t.Fatal("receipt namespace", err)
	}
	unavailable.Store(true)
	expireLink(t, s, b)
	if _, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), cmd); err != nil {
		t.Fatal(err)
	}
	failed := getBoard(t, s, b.Workspace.ID).Links[0]
	if failed.Outcome != "unavailable" || failed.Observation.Pipeline.State != "success" || !failed.LastSuccess.Equal(*next.Links[0].LastSuccess) {
		t.Fatal(failed)
	}
	// Multiple cards share one observation without crossing workspace boundaries.
	it := newItem(b, "Second card")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &it})
	apply(t, s, &b, p.Command{Kind: "link.attach", Target: b.Items[1].ID, Link: &b.Links[0].LinkTarget})
	if len(b.Links) != 1 || len(b.Links[0].Items) != 2 || b.Links[0].Observation == nil {
		t.Fatal(b.Links)
	}
	other := bootstrap(t, s)
	if _, err := s.Change(ctx, other.Workspace.ID, "alice", p.NewID(), p.Command{Kind: "link.refresh", Target: b.Links[0].ID, Revision: other.Workspace.Revision}); err == nil {
		t.Fatal("cross-workspace refresh")
	}
	if _, err := s.pool.Exec(ctx, "INSERT INTO item_external_links VALUES($1,$2,$3)", other.Workspace.ID, b.Items[0].ID, b.Links[0].ID); err == nil {
		t.Fatal("cross-workspace FK")
	}
	if err := s.SetMember(ctx, b.Workspace.ID, "viewer", "viewer"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Change(ctx, b.Workspace.ID, "viewer", p.NewID(), refreshCommand(b)); !errors.Is(err, p.ErrForbidden) {
		t.Fatal(err)
	}
	apply(t, s, &b, p.Command{Kind: "integration.save", Integration: &p.Integration{Projects: []int64{}}})
	if len(b.Links) != 0 || len(b.Items) != 2 {
		t.Fatal("revocation did not remove only links", b)
	}
}
func TestRefreshDoesNotLockPlanningAndCannotResurrectRevokedLinks(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	s, b := linkedBoard(t, func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		_, _ = w.Write([]byte(observedMR))
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := make(chan error, 1)
	cmd := refreshCommand(b)
	go func() { _, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), cmd); result <- err }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// Approval changes must finish while the network request is still blocked.
	if _, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), p.Command{Kind: "integration.save", Integration: &p.Integration{Projects: []int64{}}, Revision: b.Workspace.Revision}); err != nil {
		t.Fatal(err)
	}
	close(release) // A successful late provider response must not restore the link.
	select {
	case err := <-result:
		if !errors.Is(err, p.ErrNotFound) {
			t.Fatal("revoked refresh accepted", err)
		}
	case <-time.After(time.Second):
		t.Fatal("refresh did not finish")
	}
	if got := getBoard(t, s, b.Workspace.ID); len(got.Links) != 0 {
		t.Fatal(got.Links)
	}
}
func TestRefreshAttemptGeneration(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	var calls atomic.Int32
	s, b := linkedBoard(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
			_, _ = w.Write([]byte(observedMR))
			return
		}
		_, _ = w.Write([]byte(`{"id":100,"iid":7,"project_id":42,"sha":"new-head","head_pipeline":{"id":34,"sha":"head","status":"success"}}`))
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := make(chan error, 1)
	cmd := refreshCommand(b)
	go func() { _, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), cmd); result <- err }()
	select {
	case <-entered:
	case <-ctx.Done():
		close(release)
		t.Fatal(ctx.Err())
	}
	expireLink(t, s, b)
	_, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), cmd)
	close(release)
	if err != nil {
		t.Fatal(err)
	}
	if err = <-result; !errors.Is(err, p.ErrConflict) {
		t.Fatal("late result accepted", err)
	}
	link := getBoard(t, s, b.Workspace.ID).Links[0]
	if link.Observation.HeadSHA != "new-head" || link.Observation.Pipeline.State != "unknown" {
		t.Fatal(link)
	}
}
func TestIntegrationAuditRollback(t *testing.T) {
	for _, phase := range []string{"request", "result"} {
		t.Run(phase, func(t *testing.T) {
			var calls atomic.Int32
			s, b := linkedBoard(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = w.Write([]byte(observedMR)) })
			execSQL(t, s, `CREATE FUNCTION reject_integration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='integration.refresh.`+phase+`' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_integration BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_integration_audit()`)
			if _, err := s.Change(context.Background(), b.Workspace.ID, "alice", p.NewID(), refreshCommand(b)); err == nil {
				t.Fatal("audit failure accepted")
			}
			next := getBoard(t, s, b.Workspace.ID)
			if next.Links[0].Observation != nil || next.Workspace.Revision != b.Workspace.Revision {
				t.Fatal(next)
			}
			if phase == "request" && (calls.Load() != 0 || next.Links[0].Outcome != "unobserved") {
				t.Fatal("failed audit still fetched")
			}
		})
	}
}
func TestIntegrationMigrationAndApproval(t *testing.T) {
	s := bareStore(t)
	execSQL(t, s, schema)
	execSQL(t, s, legacyFixture)
	execSQL(t, s, workspaceMigration)
	execSQL(t, s, labelsMigration)
	if err := s.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	b := getBoard(t, s, "w")
	if len(b.Items) != 3 || len(b.Labels) != 4 || b.Labels[0].Name != "native" || b.Labels[1].Name != "priority::high" || b.Labels[2].Name != "priority::low" || b.Labels[3].Name != "priority::normal" || b.Labels[0].Color != p.DefaultLabelColor || len(b.Links) != 0 {
		t.Fatal(b)
	}
	if _, err := s.Change(context.Background(), "w", "alice", p.NewID(), p.Command{Kind: "integration.save", Revision: b.Workspace.Revision, Integration: &p.Integration{Instance: "https://arbitrary.example", Projects: []int64{42}}}); !errors.Is(err, p.ErrConflict) {
		t.Fatal("accepted arbitrary instance", err)
	}
}
