package store

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

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
