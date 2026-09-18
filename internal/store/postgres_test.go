package store

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/abagile/tokyo3-base/cli"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func bareStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("FLUX_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set FLUX_TEST_DATABASE_URL to a disposable PostgreSQL database")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := "flux_test_" + strings.ToLower(p.NewID())
	quoted := pgx.Identifier{name}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, e := admin.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE")
		admin.Close()
		if e != nil {
			t.Error(e)
		}
	})
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("search_path", name)
	u.RawQuery = q.Encode()
	s, err := Open(ctx, cli.DB{URL: u.String()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if err = s.Ready(ctx); err == nil {
		t.Fatal("unmigrated schema ready")
	}
	return s
}
func testStore(t *testing.T) *Store {
	t.Helper()
	s := bareStore(t)
	ctx := context.Background()
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatal("repeat migration:", err)
	}
	if err := s.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	return s
}
func bootstrap(t *testing.T, s *Store) p.Board {
	t.Helper()
	w, err := s.Bootstrap(context.Background(), "Team", "Project", "alice")
	if err != nil {
		t.Fatal(err)
	}
	return getBoard(t, s, w.ID)
}
func getBoard(t *testing.T, s *Store, wid string) p.Board {
	t.Helper()
	b, err := s.Board(context.Background(), wid, "alice")
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func apply(t *testing.T, s *Store, b *p.Board, c p.Command) {
	t.Helper()
	c.Revision = b.Workspace.Revision
	if _, err := s.Change(context.Background(), b.Workspace.ID, "alice", p.NewID(), c); err != nil {
		t.Fatal(err)
	}
	*b = getBoard(t, s, b.Workspace.ID)
}
func newItem(b p.Board, title string) p.Item {
	return p.Item{Title: title, ColumnID: b.Columns[0].ID, Assignee: "alice", Labels: []string{"native"}}
}
func execSQL(t *testing.T, s *Store, sql string) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(), sql); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresWorkspaceCreation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	key := strings.Repeat("k", 16)
	created, err := s.CreateWorkspace(ctx, "Team Alpha", "alice", key)
	if err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.Name != "Team Alpha" || created.Role != "admin" || created.Revision != 1 {
		t.Fatalf("created workspace = %+v", created)
	}
	board := getBoard(t, s, created.ID)
	if len(board.Projects) != 0 || len(board.Columns) != 4 || len(board.Members) != 1 || board.Members[0].Subject != "alice" || board.Members[0].Role != "admin" {
		t.Fatalf("created workspace board = %+v", board)
	}
	wantColumns := []struct {
		name, category string
		wip            int
	}{{"Ready", "todo", 0}, {"In progress", "doing", 3}, {"In review", "doing", 3}, {"Done", "done", 0}}
	for i, want := range wantColumns {
		column := board.Columns[i]
		if column.Name != want.name || column.Category != want.category || column.Position != i || column.WIP != want.wip {
			t.Fatalf("default column %d = %+v", i, column)
		}
	}
	var audits, receipts int
	if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE workspace_id=$1 AND action='workspace.create'", created.ID).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("workspace audit count = %d: %v", audits, err)
	}
	if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM idempotency_keys WHERE workspace_id=$1 AND actor=$2 AND key=$3", created.ID, "alice", key).Scan(&receipts); err != nil || receipts != 1 {
		t.Fatalf("workspace receipt count = %d: %v", receipts, err)
	}
	retried, err := s.CreateWorkspace(ctx, "Team Alpha", "alice", key)
	if err != nil || retried.ID != created.ID {
		t.Fatalf("idempotent workspace retry = %+v: %v", retried, err)
	}
	parallelKey := strings.Repeat("q", 16)
	results := make(chan struct {
		workspace p.Workspace
		err       error
	}, 2)
	var group sync.WaitGroup
	for range 2 {
		group.Go(func() {
			workspace, err := s.CreateWorkspace(ctx, "Team Beta", "alice", parallelKey)
			results <- struct {
				workspace p.Workspace
				err       error
			}{workspace, err}
		})
	}
	group.Wait()
	close(results)
	for result := range results {
		if result.err != nil || result.workspace.Name != "Team Beta" {
			t.Fatalf("concurrent workspace creation = %+v: %v", result.workspace, result.err)
		}
	}
	if _, err = s.CreateWorkspace(ctx, "Different name", "alice", key); !errors.Is(err, p.ErrConflict) {
		t.Fatalf("idempotency key reuse error = %v", err)
	}
	var workspaceCount int
	if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM workspaces").Scan(&workspaceCount); err != nil || workspaceCount != 2 {
		t.Fatalf("workspace count = %d: %v", workspaceCount, err)
	}
}

func TestPostgresWorkspaceCreationRollsBack(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	execSQL(t, s, "ALTER TABLE audit_events ADD CONSTRAINT injected_failure CHECK(false) NOT VALID")
	if _, err := s.CreateWorkspace(ctx, "Rollback", "alice", strings.Repeat("r", 16)); err == nil {
		t.Fatal("workspace creation accepted an unavailable audit sink")
	}
	for _, table := range []string{"workspaces", "memberships", "board_columns", "audit_events", "idempotency_keys"} {
		var count int
		if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s partial commit: %d: %v", table, count, err)
		}
	}
}

func TestPostgresNativeLifecycle(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	wid := b.Workspace.ID
	ws, err := s.Workspaces(ctx, "alice")
	if err != nil || len(ws) != 1 {
		t.Fatal(ws, err)
	}
	projects, err := s.Projects(ctx, wid, "alice")
	if err != nil || len(projects) != 1 {
		t.Fatal(projects, err)
	}
	it := newItem(b, "First")
	c := p.Command{Kind: "item.create", Revision: b.Workspace.Revision, Item: &it}
	key := p.NewID()
	rev, err := s.Change(ctx, wid, "alice", key, c)
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Change(ctx, wid, "alice", key, c)
	if err != nil || rev != again {
		t.Fatalf("receipt: %d %d %v", rev, again, err)
	}
	different := c
	different.Reason = "different"
	if _, err = s.Change(ctx, wid, "alice", key, different); !errors.Is(err, p.ErrConflict) {
		t.Fatal("key misuse:", err)
	}
	b = getBoard(t, s, wid)
	if len(b.Items) != 1 || b.Items[0].ProjectID != "" || len(b.Items[0].SprintIDs) != 0 {
		t.Fatal("optional classification")
	}
	it = b.Items[0]
	it.ProjectIDs = []string{projects[0].ID}
	it.Description = "Acceptance criteria"
	apply(t, s, &b, p.Command{Kind: "item.update", Target: it.ID, Item: &it})
	apply(t, s, &b, p.Command{Kind: "item.archive", Target: it.ID})
	if !b.Items[0].Archived {
		t.Fatal("archive")
	}
	apply(t, s, &b, p.Command{Kind: "item.restore", Target: it.ID})
	events, err := s.History(ctx, wid, "alice", 0)
	if err != nil || len(events) != 4 || events[0].Action != "item.restore" || events[0].LegacyProjectID != "" {
		t.Fatal(events, err)
	}
	var audits int
	if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE workspace_id=$1", wid).Scan(&audits); err != nil || audits != 5 {
		t.Fatal(audits, err)
	}
	if _, err = s.Change(ctx, wid, "alice", p.NewID(), c); !errors.Is(err, p.ErrConflict) {
		t.Fatal("stale revision:", err)
	}
}
func TestPostgresMultiProjectPersistence(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	apply(t, s, &b, p.Command{Kind: "project.save", Project: &p.Project{Name: "Second"}})
	item := newItem(b, "Shared classification")
	item.ProjectIDs = []string{b.Projects[0].ID, b.Projects[1].ID}
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})
	if !slices.Equal(b.Items[0].ProjectIDs, []string{b.Projects[0].ID, b.Projects[1].ID}) || b.Items[0].ProjectID != b.Projects[0].ID {
		t.Fatalf("multiple project associations were not loaded: %+v", b.Items[0])
	}
	var count int
	if err := s.pool.QueryRow(context.Background(), "SELECT count(*) FROM item_projects WHERE workspace_id=$1 AND item_id=$2", b.Workspace.ID, b.Items[0].ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("stored project associations = %d: %v", count, err)
	}
	item = b.Items[0]
	item.ProjectIDs = []string{b.Projects[1].ID}
	apply(t, s, &b, p.Command{Kind: "item.update", Target: item.ID, Item: &item})
	if !slices.Equal(b.Items[0].ProjectIDs, []string{b.Projects[1].ID}) {
		t.Fatalf("updated project associations were not loaded: %+v", b.Items[0])
	}
}
func TestPostgresPermissionsAndIsolation(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	wid := b.Workspace.ID
	if err := s.SetMember(ctx, wid, "reader", "viewer"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Board(ctx, wid, "reader"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Change(ctx, wid, "reader", p.NewID(), p.Command{Kind: "item.create", Revision: 1, Item: &p.Item{}}); !errors.Is(err, p.ErrForbidden) {
		t.Fatal("viewer write", err)
	}
	other, err := s.Bootstrap(ctx, "Other", "Other project", "bob")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Board(ctx, other.ID, "alice"); !errors.Is(err, p.ErrForbidden) {
		t.Fatal("cross workspace read", err)
	}
	if _, err = s.History(ctx, other.ID, "alice", 0); !errors.Is(err, p.ErrForbidden) {
		t.Fatal("cross history", err)
	}
	if _, err = s.Projects(ctx, other.ID, "alice"); !errors.Is(err, p.ErrForbidden) {
		t.Fatal("cross projects", err)
	}
	foreign, err := s.Board(ctx, other.ID, "bob")
	if err != nil {
		t.Fatal(err)
	}
	it := newItem(b, "Forbidden classification")
	it.ProjectID = foreign.Projects[0].ID
	if _, err = s.Change(ctx, wid, "alice", p.NewID(), p.Command{Kind: "item.create", Revision: b.Workspace.Revision, Item: &it}); !errors.Is(err, p.ErrInvalid) {
		t.Fatal("foreign project", err)
	}
	it.ProjectID = ""
	it.SprintIDs = []string{"foreign-sprint"}
	if _, err = s.Change(ctx, wid, "alice", p.NewID(), p.Command{Kind: "item.create", Revision: b.Workspace.Revision, Item: &it}); !errors.Is(err, p.ErrInvalid) {
		t.Fatal("foreign sprint", err)
	}
	if err = s.SetMember(ctx, wid, "alice", "viewer"); !errors.Is(err, p.ErrInvalid) {
		t.Fatal("last admin", err)
	}
	if err = s.SetMember(ctx, wid, "reader", "admin"); err != nil {
		t.Fatal(err)
	}
	if err = s.SetMember(ctx, wid, "alice", "member"); err != nil {
		t.Fatal(err)
	}
}
func TestPostgresAuditFailureRollsBack(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	execSQL(t, s, "ALTER TABLE audit_events ADD CONSTRAINT injected_failure CHECK(false) NOT VALID")
	it := newItem(b, "Rollback")
	if _, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), p.Command{Kind: "item.create", Revision: 1, Item: &it}); err == nil {
		t.Fatal("audit accepted")
	}
	next := getBoard(t, s, b.Workspace.ID)
	if next.Workspace.Revision != 1 || len(next.Items) != 0 {
		t.Fatal("partial commit")
	}
	for _, table := range []string{"work_item_events", "idempotency_keys", "item_sprints"} {
		var count int
		if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 0 {
			t.Fatal(table, count, err)
		}
	}
}
func TestPostgresConcurrentWorkspaceWIP(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	apply(t, s, &b, p.Command{Kind: "project.save", Project: &p.Project{Name: "Other project"}})
	for i, name := range []string{"A", "B"} {
		it := newItem(b, name)
		it.ProjectID = b.Projects[i].ID
		apply(t, s, &b, p.Command{Kind: "item.create", Item: &it})
	}
	col := b.Columns[1]
	col.WIP = 1
	apply(t, s, &b, p.Command{Kind: "column.save", Target: col.ID, Column: &col})
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, it := range b.Items {
		wg.Go(func() {
			_, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), p.Command{Kind: "item.move", Revision: b.Workspace.Revision, Target: it.ID, Destination: col.ID})
			errs <- err
		})
	}
	wg.Wait()
	close(errs)
	successes, conflicts := 0, 0
	for err := range errs {
		if err == nil {
			successes++
		} else if errors.Is(err, p.ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal(successes, conflicts)
	}
	b = getBoard(t, s, b.Workspace.ID)
	for _, it := range b.Items {
		if it.ColumnID != col.ID {
			_, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), p.Command{Kind: "item.move", Revision: b.Workspace.Revision, Target: it.ID, Destination: col.ID})
			if !errors.Is(err, p.ErrInvalid) {
				t.Fatal("cross-project WIP overflow", err)
			}
		}
	}
	last := b.Items[1].ID
	apply(t, s, &b, p.Command{Kind: "item.rank", Target: last, Before: b.Items[0].ID})
	if b.Items[0].ID != last {
		t.Fatal("rank")
	}
}
func TestPostgresMultiSprintAndCrossProjectDependencies(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	apply(t, s, &b, p.Command{Kind: "project.save", Project: &p.Project{Name: "Second"}})
	for _, name := range []string{"First", "Second"} {
		sp := p.Sprint{Name: name, Goal: "Shared goal", Start: "2026-09-01", End: "2026-09-14"}
		apply(t, s, &b, p.Command{Kind: "sprint.save", Sprint: &sp})
	}
	sid, next := b.Sprints[0].ID, b.Sprints[1].ID
	apply(t, s, &b, p.Command{Kind: "sprint.start", Target: sid})
	apply(t, s, &b, p.Command{Kind: "sprint.start", Target: next})
	for i, name := range []string{"A", "B"} {
		it := newItem(b, name)
		it.ProjectID = b.Projects[i].ID
		it.SprintIDs = []string{sid, next}
		if i == 1 {
			it.Dependencies = []string{b.Items[0].ID}
		}
		apply(t, s, &b, p.Command{Kind: "item.create", Item: &it})
	}
	it := b.Items[0]
	it.Dependencies = []string{b.Items[1].ID}
	if _, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), p.Command{Kind: "item.update", Target: it.ID, Revision: b.Workspace.Revision, Item: &it}); !errors.Is(err, p.ErrInvalid) {
		t.Fatal("cross-project cycle", err)
	}
	apply(t, s, &b, p.Command{Kind: "sprint.close", Target: sid, Destination: next, Reason: "Continue across sprints"})
	if len(b.ClosedScope) != 2 {
		t.Fatal("scope")
	}
	for _, it := range b.Items {
		if !slices.Equal(it.SprintIDs, []string{next}) {
			t.Fatal("duplicated or removed membership")
		}
	}
	apply(t, s, &b, p.Command{Kind: "item.archive", Target: b.Items[0].ID})
	if len(b.ClosedScope) != 2 || len(b.Items[0].SprintIDs) != 0 {
		t.Fatal("archive scope")
	}
	apply(t, s, &b, p.Command{Kind: "item.restore", Target: b.Items[0].ID})
	apply(t, s, &b, p.Command{Kind: "sprint.close", Target: next, Reason: "Backlog"})
	if len(b.ClosedScope) != 3 {
		t.Fatal("closed history")
	}
	col := b.Columns[0]
	apply(t, s, &b, p.Command{Kind: "column.delete", Target: col.ID, Destination: b.Columns[1].ID})
	if len(b.Columns) != 3 {
		t.Fatal("column delete")
	}
	it = b.Items[0]
	it.ProjectIDs = []string{}
	apply(t, s, &b, p.Command{Kind: "item.update", Target: it.ID, Item: &it})
	if b.Items[0].ProjectID != "" {
		t.Fatal("clearing project")
	}
}
func TestPostgresProjectlessWorkspace(t *testing.T) {
	s := testStore(t)
	w, err := s.Bootstrap(context.Background(), "Personal", "", "alice")
	if err != nil {
		t.Fatal(err)
	}
	b := getBoard(t, s, w.ID)
	if len(b.Projects) != 0 || len(b.Columns) != 4 {
		t.Fatal("workspace requires project")
	}
	it := newItem(b, "Unclassified")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &it})
	apply(t, s, &b, p.Command{Kind: "project.save", Project: &p.Project{Name: "Optional"}})
	project := b.Projects[0]
	project.Name = "Renamed"
	apply(t, s, &b, p.Command{Kind: "project.save", Target: project.ID, Project: &project})
	if b.Projects[0].Name != "Renamed" || b.Items[0].ProjectID != "" {
		t.Fatal("classification changed implicitly")
	}
}
func TestPostgresHistoryPagination(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	it := newItem(b, "History")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &it})
	for i := range 51 {
		it = b.Items[0]
		it.Title = fmt.Sprintf("Version %d", i)
		apply(t, s, &b, p.Command{Kind: "item.update", Target: it.ID, Item: &it})
	}
	first, err := s.History(ctx, b.Workspace.ID, "alice", 0)
	if err != nil || len(first) != 50 {
		t.Fatal(first, err)
	}
	second, err := s.History(ctx, b.Workspace.ID, "alice", first[49].ID)
	if err != nil || len(second) != 2 || second[0].ID >= first[49].ID {
		t.Fatal(second, err)
	}
}

const legacyFixture = `
 INSERT INTO workspaces VALUES('w','Team'); INSERT INTO memberships VALUES('w','alice','admin');
 INSERT INTO projects VALUES('p1','w','One',8),('p2','w','Two',5);
 INSERT INTO board_columns VALUES('p1','c1','Ready','todo',0,2),('p2','c2','Ready','todo',0,3);
 INSERT INTO sprints VALUES('p1','s1','First','Goal','2026-09-01','2026-09-14','active',1),('p2','s2','Second','Goal','2026-09-01','2026-09-14','active',1),('p1','closed','Closed','Goal','2026-08-01','2026-08-14','closed',2);
 INSERT INTO work_items VALUES('p1','w','a','A','Description','c1','s1','alice','normal',0,2,false),('p2','w','b','B','Description','c2','s2',NULL,'high',0,3,false),('p1','w','c','C','Archived','c1',NULL,NULL,'low',1,4,true);
 INSERT INTO item_labels VALUES('p1','a','native'); INSERT INTO dependencies VALUES('p1','a','c');
 INSERT INTO closed_sprint_scope VALUES('p1','closed','a');
 INSERT INTO work_item_events(project_id,revision,actor,action,target,reason) VALUES('p1',8,'alice','item.create','a','legacy');
 INSERT INTO audit_events(workspace_id,project_id,actor,action,request_id,before_state,after_state,outcome) VALUES('w','p1','alice','item.create','original','{"legacy":true}','{"original":true}','success');
 INSERT INTO idempotency_keys VALUES('p1','alice','same-original-key','old',8),('p2','alice','same-original-key','old',5);
`

func TestMigrateWorkspacePreservesLegacyData(t *testing.T) {
	s := bareStore(t)
	ctx := context.Background()
	execSQL(t, s, schema)
	execSQL(t, s, legacyFixture)
	if err := s.Ready(ctx); err == nil {
		t.Fatal("v1 ready for v2 server")
	}
	var before string
	if err := s.pool.QueryRow(ctx, "SELECT before_state::text FROM audit_events").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	b := getBoard(t, s, "w")
	var hasPriority bool
	if err := s.pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='work_items' AND column_name='priority')").Scan(&hasPriority); err != nil || hasPriority {
		t.Fatalf("priority column retained: %v", err)
	}
	if len(b.Projects) != 2 || len(b.Items) != 3 || len(b.Columns) != 2 || len(b.Sprints) != 3 || len(b.ClosedScope) != 1 || b.Workspace.Revision != 9 {
		t.Fatalf("lost legacy data: %+v", b)
	}
	for _, it := range b.Items {
		switch it.ID {
		case "a":
			if it.ProjectID != "p1" || !slices.Equal(it.ProjectIDs, []string{"p1"}) || !slices.Equal(it.SprintIDs, []string{"s1"}) || !slices.Equal(it.Labels, []string{"native", "priority::normal"}) || !slices.Equal(it.Dependencies, []string{"c"}) {
				t.Fatal(it)
			}
		case "c":
			if !it.Archived || it.Revision != 4 {
				t.Fatal(it)
			}
		}
	}
	if b.Columns[0].WIP != 2 || b.Columns[1].WIP != 3 || b.Columns[0].ID != "c1" || b.Columns[1].ID != "c2" {
		t.Fatal("column policies/identity changed")
	}
	history, err := s.History(ctx, "w", "alice", 0)
	if err != nil || len(history) != 1 || history[0].LegacyProjectID != "p1" || history[0].Revision != 8 {
		t.Fatal(history, err)
	}
	var after string
	if err = s.pool.QueryRow(ctx, "SELECT before_state::text FROM audit_events").Scan(&after); err != nil || before != after {
		t.Fatal("audit rewritten", err)
	}
	var count int
	if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM legacy_idempotency_keys").Scan(&count); err != nil || count != 2 {
		t.Fatal("legacy receipts lost", err)
	}
	it := newItem(b, "New workspace item")
	if _, err = s.Change(ctx, "w", "alice", "same-original-key", p.Command{Kind: "item.create", Revision: b.Workspace.Revision, Item: &it}); err != nil {
		t.Fatal("legacy receipt collided", err)
	}
}
func TestMigrationRollbackOnOversizedWorkspace(t *testing.T) {
	s := bareStore(t)
	execSQL(t, s, schema)
	execSQL(t, s, legacyFixture)
	execSQL(t, s, `INSERT INTO work_items(project_id,workspace_id,id,title,description,column_id,priority,rank,revision,archived) SELECT 'p1','w','extra-'||n,'Item','','c1','normal',n,1,true FROM generate_series(1,1000) n`)
	if err := s.Migrate(context.Background()); err == nil {
		t.Fatal("oversized board silently truncated")
	}
	var version int
	if err := s.pool.QueryRow(context.Background(), "SELECT version FROM flux_schema").Scan(&version); err != nil || version != 1 {
		t.Fatal("partial migration", version, err)
	}
}
func TestDatabaseTLSConfiguration(t *testing.T) {
	cfg, err := pgxpool.ParseConfig("postgres://db.example.test/flux?sslmode=prefer")
	if err != nil {
		t.Fatal(err)
	}
	material := &tls.Config{MinVersion: tls.VersionTLS12}
	configurePool(cfg, material)
	if cfg.ConnConfig.TLSConfig.ServerName != "db.example.test" || cfg.ConnConfig.TLSConfig.InsecureSkipVerify || len(cfg.ConnConfig.Fallbacks) != 0 || material.ServerName != "" {
		t.Fatal("TLS verification/downgrade")
	}
	cfg, err = pgxpool.ParseConfig("postgres://localhost/flux?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	configurePool(cfg, nil)
	if cfg.ConnConfig.TLSConfig != nil {
		t.Fatal("DSN behavior changed")
	}
}
func TestPostgresConfiguration(t *testing.T) {
	for _, dsn := range []string{"", "sqlite:test.db", "%invalid"} {
		if s, err := Open(context.Background(), cli.DB{URL: dsn}); err == nil {
			s.Close()
			t.Fatal("accepted", dsn)
		}
	}
}
