package store

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

// countWorkspaces reports how many workspace rows exist, which is the only
// observable that distinguishes a replayed receipt from a duplicate create.
func countWorkspaces(t *testing.T, s *Store) int {
	t.Helper()
	var count int
	if err := s.pool.QueryRow(context.Background(), "SELECT count(*) FROM workspaces").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestReclosingSprintPersistsLatestScope(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	apply(t, s, &b, p.Command{Kind: "sprint.save", Sprint: &p.Sprint{Name: "Review", Goal: "Latest scope", Start: "2026-09-21", End: "2026-10-04"}})
	sprintID := b.Sprints[len(b.Sprints)-1].ID
	apply(t, s, &b, p.Command{Kind: "sprint.start", Target: sprintID})
	for _, title := range []string{"Keep", "Remove"} {
		item := newItem(b, title)
		item.SprintIDs = []string{sprintID}
		apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})
	}
	var keep, remove p.Item
	for _, item := range b.Items {
		switch item.Title {
		case "Keep":
			keep = item
		case "Remove":
			remove = item
		}
	}
	apply(t, s, &b, p.Command{Kind: "sprint.close", Target: sprintID, Reason: "First closure"})
	apply(t, s, &b, p.Command{Kind: "sprint.reopen", Target: sprintID})
	remove.SprintIDs = nil
	remove.Revision = b.Items[slices.IndexFunc(b.Items, func(item p.Item) bool { return item.ID == remove.ID })].Revision
	apply(t, s, &b, p.Command{Kind: "item.update", Target: remove.ID, Item: &remove})
	apply(t, s, &b, p.Command{Kind: "sprint.close", Target: sprintID, Reason: "Updated closure"})
	if len(b.ClosedScope) != 1 || b.ClosedScope[0].ItemID != keep.ID {
		t.Fatalf("latest closure scope = %+v, want only %s", b.ClosedScope, keep.ID)
	}
	apply(t, s, &b, p.Command{Kind: "sprint.reopen", Target: sprintID})
	if slices.Contains(b.Items[slices.IndexFunc(b.Items, func(item p.Item) bool { return item.ID == remove.ID })].SprintIDs, sprintID) {
		t.Fatal("reopen restored stale scope")
	}
	if !slices.Contains(b.Items[slices.IndexFunc(b.Items, func(item p.Item) bool { return item.ID == keep.ID })].SprintIDs, sprintID) {
		t.Fatal("reopen lost current scope")
	}
}

// A repeated request with the same key and name must return the original
// workspace rather than creating a second one. This is the path a browser
// takes when the response to its first create was lost.
func TestCreateWorkspaceReplaysTheSameReceipt(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	key := p.NewID()
	first, err := s.CreateWorkspace(ctx, "Team Alpha", "alice", key)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == "" || first.Role != "admin" || first.Revision != 1 {
		t.Fatalf("unexpected workspace %+v", first)
	}
	second, err := s.CreateWorkspace(ctx, "Team Alpha", "alice", key)
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("replay returned %+v, want %+v", second, first)
	}
	if count := countWorkspaces(t, s); count != 1 {
		t.Fatalf("workspaces = %d, want 1", count)
	}
	// The replayed workspace must be usable, not just echoed back.
	b := getBoard(t, s, first.ID)
	if len(b.Columns) != 4 || b.Role != "admin" {
		t.Fatalf("replayed workspace has no usable board: %d columns, role %q", len(b.Columns), b.Role)
	}
}

// Reusing a key for a different name is a client error, not a silent rename or
// a second workspace.
func TestCreateWorkspaceRejectsReusedKeyForAnotherName(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	key := p.NewID()
	if _, err := s.CreateWorkspace(ctx, "Team Alpha", "alice", key); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateWorkspace(ctx, "Team Beta", "alice", key); !errors.Is(err, p.ErrConflict) {
		t.Fatalf("reused key error = %v, want conflict", err)
	}
	if count := countWorkspaces(t, s); count != 1 {
		t.Fatalf("workspaces = %d, want 1", count)
	}
}

// The key is scoped to the actor. Another member reusing the same string gets
// their own workspace instead of joining someone else's.
func TestCreateWorkspaceScopesTheKeyToTheActor(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	key := p.NewID()
	mine, err := s.CreateWorkspace(ctx, "Team Alpha", "alice", key)
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := s.CreateWorkspace(ctx, "Team Alpha", "bob", key)
	if err != nil {
		t.Fatal(err)
	}
	if mine.ID == theirs.ID {
		t.Fatal("two actors shared one workspace through a shared key")
	}
	if count := countWorkspaces(t, s); count != 2 {
		t.Fatalf("workspaces = %d, want 2", count)
	}
	if _, err = s.Board(ctx, mine.ID, "bob"); !errors.Is(err, p.ErrForbidden) {
		t.Fatalf("cross-actor board access = %v, want forbidden", err)
	}
}

// The idempotency receipt is the fast path; the audit event is the durable
// fallback. Losing the receipt row must still replay instead of duplicating.
func TestCreateWorkspaceReplaysFromTheAuditReceipt(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	key := p.NewID()
	first, err := s.CreateWorkspace(ctx, "Team Alpha", "alice", key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, "DELETE FROM idempotency_keys WHERE actor=$1 AND key=$2", "alice", key); err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateWorkspace(ctx, "Team Alpha", "alice", key)
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("audit replay returned %+v, want %+v", second, first)
	}
	if count := countWorkspaces(t, s); count != 1 {
		t.Fatalf("workspaces = %d, want 1", count)
	}
	// A receipt that no longer resolves to a readable workspace is a conflict,
	// never a fresh create under the same key.
	if _, err = s.pool.Exec(ctx, "DELETE FROM idempotency_keys WHERE actor=$1 AND key=$2", "alice", key); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, "DELETE FROM memberships WHERE workspace_id=$1", first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateWorkspace(ctx, "Team Alpha", "alice", key); !errors.Is(err, p.ErrConflict) {
		t.Fatalf("unresolvable receipt error = %v, want conflict", err)
	}
}

// Concurrent retries of one lost request must serialize on the advisory lock
// and agree on a single workspace.
func TestConcurrentCreateWorkspaceCreatesOne(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	key := p.NewID()
	results := make(chan p.Workspace, 4)
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			w, err := s.CreateWorkspace(ctx, "Team Alpha", "alice", key)
			if err != nil {
				t.Error(err)
				return
			}
			results <- w
		})
	}
	wg.Wait()
	close(results)
	var first p.Workspace
	for w := range results {
		if first.ID == "" {
			first = w
		}
		if w != first {
			t.Fatalf("concurrent creates disagreed: %+v and %+v", w, first)
		}
	}
	if first.ID == "" {
		t.Fatal("no concurrent create succeeded")
	}
	if count := countWorkspaces(t, s); count != 1 {
		t.Fatalf("workspaces = %d, want 1", count)
	}
}

// Input bounds are enforced before any row is written, so a rejected request
// leaves no workspace and burns no key.
func TestCreateWorkspaceValidatesInput(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	tests := []struct{ name, workspace, subject, key string }{
		{"empty name", "   ", "alice", p.NewID()},
		{"long name", strings.Repeat("n", 121), "alice", p.NewID()},
		{"newline in name", "Team\nAlpha", "alice", p.NewID()},
		{"empty subject", "Team Alpha", "", p.NewID()},
		{"short key", "Team Alpha", "alice", "tooshort"},
		{"long key", "Team Alpha", "alice", strings.Repeat("k", 121)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.CreateWorkspace(ctx, tc.workspace, tc.subject, tc.key); !errors.Is(err, p.ErrInvalid) {
				t.Fatalf("error = %v, want invalid", err)
			}
		})
	}
	if count := countWorkspaces(t, s); count != 0 {
		t.Fatalf("workspaces = %d, want 0", count)
	}
}

// The name is stored trimmed, and the digest must match the trimmed form so a
// retry that differs only in surrounding whitespace still replays.
func TestCreateWorkspaceTrimsNameBeforeMatching(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	key := p.NewID()
	first, err := s.CreateWorkspace(ctx, "  Team Alpha  ", "alice", key)
	if err != nil {
		t.Fatal(err)
	}
	if first.Name != "Team Alpha" {
		t.Fatalf("stored name = %q, want trimmed", first.Name)
	}
	second, err := s.CreateWorkspace(ctx, "Team Alpha", "alice", key)
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("whitespace retry returned %+v, want %+v", second, first)
	}
}

func TestMigrateEmptyWorkspace(t *testing.T) {
	s := bareStore(t)
	execSQL(t, s, schema)
	execSQL(t, s, "INSERT INTO workspaces VALUES('empty','No projects'); INSERT INTO memberships VALUES('empty','alice','admin')")
	if err := s.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	b := getBoard(t, s, "empty")
	if len(b.Projects) != 0 || len(b.Columns) != 4 {
		t.Fatal("empty workspace has no usable board")
	}
	it := newItem(b, "Unclassified")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &it})
}

func TestWorkspaceForeignKeys(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	w, err := s.Bootstrap(ctx, "Other", "Other", "alice")
	if err != nil {
		t.Fatal(err)
	}
	other := getBoard(t, s, w.ID)
	sp := p.Sprint{Name: "Other sprint", Goal: "Goal", Start: "2026-09-01", End: "2026-09-14"}
	apply(t, s, &other, p.Command{Kind: "sprint.save", Sprint: &sp})
	it := newItem(b, "Native")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &it})
	foreignItem := newItem(other, "Foreign")
	apply(t, s, &other, p.Command{Kind: "item.create", Item: &foreignItem})
	tests := []struct {
		query string
		args  []any
	}{
		{"UPDATE work_items SET project_id=$1 WHERE workspace_id=$2 AND id=$3", []any{other.Projects[0].ID, b.Workspace.ID, b.Items[0].ID}},
		{"UPDATE work_items SET column_id=$1 WHERE workspace_id=$2 AND id=$3", []any{other.Columns[0].ID, b.Workspace.ID, b.Items[0].ID}},
		{"INSERT INTO item_sprints VALUES($1,$2,$3)", []any{b.Workspace.ID, b.Items[0].ID, other.Sprints[0].ID}},
		{"INSERT INTO dependencies(workspace_id,item_id,depends_on) VALUES($1,$2,$3)", []any{b.Workspace.ID, b.Items[0].ID, other.Items[0].ID}},
		{"INSERT INTO closed_sprint_scope(workspace_id,sprint_id,item_id) VALUES($1,$2,$3)", []any{b.Workspace.ID, other.Sprints[0].ID, b.Items[0].ID}},
	}
	for _, tc := range tests {
		if _, err = s.pool.Exec(ctx, tc.query, tc.args...); err == nil {
			t.Fatal("database accepted foreign workspace reference", tc.query)
		}
	}
}

func TestSprintCloseAuditRollback(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	for _, name := range []string{"First", "Next"} {
		sp := p.Sprint{Name: name, Goal: "Goal", Start: "2026-09-01", End: "2026-09-14"}
		apply(t, s, &b, p.Command{Kind: "sprint.save", Sprint: &sp})
	}
	sid, next := b.Sprints[0].ID, b.Sprints[1].ID
	apply(t, s, &b, p.Command{Kind: "sprint.start", Target: sid})
	it := newItem(b, "Spanning")
	it.SprintIDs = []string{sid, next}
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &it})
	execSQL(t, s, "ALTER TABLE audit_events ADD CONSTRAINT reject_close CHECK(action <> 'sprint.close') NOT VALID")
	_, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), p.Command{Kind: "sprint.close", Revision: b.Workspace.Revision, Target: sid, Reason: "Close"})
	if err == nil {
		t.Fatal("audit failure ignored")
	}
	current := getBoard(t, s, b.Workspace.ID)
	if current.Workspace.Revision != b.Workspace.Revision || len(current.ClosedScope) != 0 || len(current.Items[0].SprintIDs) != 2 || current.Sprints[0].State != "active" {
		t.Fatal("partial close")
	}
}

func TestConcurrentCloseAndScopeEdit(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	for _, name := range []string{"First", "Next"} {
		sp := p.Sprint{Name: name, Goal: "Goal", Start: "2026-09-01", End: "2026-09-14"}
		apply(t, s, &b, p.Command{Kind: "sprint.save", Sprint: &sp})
	}
	sid, next := b.Sprints[0].ID, b.Sprints[1].ID
	apply(t, s, &b, p.Command{Kind: "sprint.start", Target: sid})
	it := newItem(b, "Spanning")
	it.SprintIDs = []string{sid, next}
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &it})
	it = b.Items[0]
	it.SprintIDs = []string{next}
	commands := []p.Command{{Kind: "sprint.close", Target: sid, Reason: "Close"}, {Kind: "item.update", Target: it.ID, Item: &it}}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, c := range commands {
		wg.Go(func() {
			c.Revision = b.Workspace.Revision
			_, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), c)
			results <- err
		})
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, p.ErrConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal(success, conflict)
	}
	current := getBoard(t, s, b.Workspace.ID)
	if !slices.Equal(current.Items[0].SprintIDs, []string{next}) {
		t.Fatal("other sprint membership lost")
	}
}
