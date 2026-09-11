package planning

import (
	"errors"
	"slices"
	"testing"
)

func testBoard() Board {
	return Board{Workspace: Workspace{ID: "w", Name: "Team", Revision: 1}, Projects: []Project{{ID: "p1", WorkspaceID: "w", Name: "First", Revision: 1}, {ID: "p2", WorkspaceID: "w", Name: "Second", Revision: 1}}, Role: "member", Members: []Member{{Subject: "alice", Role: "member"}}, Columns: []Column{{ID: "ready", Name: "Ready", Category: "todo"}, {ID: "doing", Name: "Doing", Category: "doing", WIP: 1}, {ID: "done", Name: "Done", Category: "done"}}, Items: []Item{{ID: "a", Title: "A", ColumnID: "ready", Revision: 1}, {ID: "b", Title: "B", ColumnID: "ready", Revision: 1}}, Sprints: []Sprint{{ID: "s1", Name: "First", Goal: "Ship", Start: "2026-09-01", End: "2026-09-14", State: "planned", Revision: 1}, {ID: "s2", Name: "Next", Goal: "Learn", Start: "2026-09-15", End: "2026-09-28", State: "planned", Revision: 1}}}
}
func mustApply(t *testing.T, b *Board, c Command) {
	t.Helper()
	c.Revision = b.Workspace.Revision
	if err := Apply(b, c); err != nil {
		t.Fatal(err)
	}
}

func TestApplyValidation(t *testing.T) {
	tests := []struct {
		name  string
		setup func(*Board)
		c     Command
		want  error
	}{
		{"stale", nil, Command{Kind: "item.archive", Target: "a", Revision: 9}, ErrConflict},
		{"missing", nil, Command{Kind: "item.archive", Target: "missing"}, ErrNotFound},
		{"unknown kind", nil, Command{Kind: "sql"}, ErrInvalid},
		{"missing create", nil, Command{Kind: "item.create"}, ErrInvalid},
		{"item note replaced by comments", nil, Command{Kind: "item.update", Target: "a", Reason: "old note", Item: &Item{ID: "a", Revision: 1, Title: "A", ColumnID: "ready"}}, ErrInvalid},
		{"foreign column", nil, Command{Kind: "item.move", Target: "a", Destination: "foreign"}, ErrInvalid},
		{"WIP full", func(b *Board) { b.Items[1].ColumnID = "doing" }, Command{Kind: "item.move", Target: "a", Destination: "doing"}, ErrInvalid},
		{"archived move", func(b *Board) { b.Items[0].Archived = true }, Command{Kind: "item.move", Target: "a", Destination: "doing"}, ErrInvalid},
		{"bad anchor", nil, Command{Kind: "item.rank", Target: "a", Before: "missing"}, ErrInvalid},
		{"self anchor", nil, Command{Kind: "item.rank", Target: "a", Before: "a"}, ErrInvalid},
		{"last column", func(b *Board) { b.Columns = b.Columns[:1] }, Command{Kind: "column.delete", Target: "ready", Destination: "ready"}, ErrInvalid},
		{"same destination", nil, Command{Kind: "column.delete", Target: "ready", Destination: "ready"}, ErrInvalid},
		{"start closed", func(b *Board) { b.Sprints[0].State = "closed" }, Command{Kind: "sprint.start", Target: "s1"}, ErrInvalid},
		{"close planned", nil, Command{Kind: "sprint.close", Target: "s1", Reason: "done"}, ErrInvalid},
		{"close reason", func(b *Board) { b.Sprints[0].State = "active" }, Command{Kind: "sprint.close", Target: "s1"}, ErrInvalid},
		{"self carry", func(b *Board) { b.Sprints[0].State = "active" }, Command{Kind: "sprint.close", Target: "s1", Destination: "s1", Reason: "done"}, ErrInvalid},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b := testBoard()
			if tc.setup != nil {
				tc.setup(&b)
			}
			if tc.c.Revision == 0 {
				tc.c.Revision = b.Workspace.Revision
			}
			if err := Apply(&b, tc.c); !errors.Is(err, tc.want) {
				t.Fatalf("got %v want %v", err, tc.want)
			}
		})
	}
}
func TestWorkspaceValidation(t *testing.T) {
	cases := map[string]func(*Board){
		"title": func(b *Board) { b.Items[0].Title = " " }, "assignee": func(b *Board) { b.Items[0].Assignee = "outsider" },
		"foreign project": func(b *Board) { b.Items[0].ProjectID = "foreign" }, "foreign sprint": func(b *Board) { b.Items[0].SprintIDs = []string{"foreign"} },
		"closed sprint": func(b *Board) { b.Sprints[0].State = "closed"; b.Items[0].SprintIDs = []string{"s1"} }, "duplicate sprint": func(b *Board) { b.Items[0].SprintIDs = []string{"s1", "s1"} },
		"self dependency": func(b *Board) { b.Items[0].Dependencies = []string{"a"} }, "foreign dependency": func(b *Board) { b.Items[0].Dependencies = []string{"foreign"} },
		"cycle":           func(b *Board) { b.Items[0].Dependencies = []string{"b"}; b.Items[1].Dependencies = []string{"a"} },
		"duplicate label": func(b *Board) { b.Items[0].Labels = []string{"test", "test"} }, "dates": func(b *Board) { b.Sprints[0].End = "2026-08-01" }, "goal": func(b *Board) { b.Sprints[0].Goal = "" },
		"WIP": func(b *Board) { b.Columns[0].WIP = -1 }, "category": func(b *Board) { b.Columns[0].Category = "gitlab-merged" }, "project name": func(b *Board) { b.Projects[0].Name = "" },
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			b := testBoard()
			setup(&b)
			if err := Validate(&b); !errors.Is(err, ErrInvalid) {
				t.Fatalf("got %v", err)
			}
		})
	}
}
func TestNativeLifecycleAndOrdering(t *testing.T) {
	b := testBoard()
	it := Item{Title: "New", ColumnID: "ready", Assignee: "alice", Labels: []string{"native"}}
	mustApply(t, &b, Command{Kind: "item.create", Item: &it})
	id := b.Items[2].ID
	mustApply(t, &b, Command{Kind: "item.rank", Target: id, Before: "a"})
	if b.Items[0].ID != id {
		t.Fatal("rank")
	}
	it = b.Items[0]
	it.Title = "Edited"
	it.ProjectID = "p1"
	it.SprintIDs = []string{"s1", "s2"}
	mustApply(t, &b, Command{Kind: "item.update", Target: id, Item: &it})
	mustApply(t, &b, Command{Kind: "item.move", Target: id, Destination: "doing"})
	mustApply(t, &b, Command{Kind: "item.archive", Target: id})
	i := itemIndex(&b, id)
	if !b.Items[i].Archived || len(b.Items[i].SprintIDs) != 0 {
		t.Fatal("archive did not clear open scope")
	}
	mustApply(t, &b, Command{Kind: "item.restore", Target: id})
	mustApply(t, &b, Command{Kind: "column.save", Column: &Column{Name: "Review", Category: "doing", WIP: 2}})
	col := b.Columns[len(b.Columns)-1].ID
	mustApply(t, &b, Command{Kind: "column.rank", Target: col, Before: "done"})
	mustApply(t, &b, Command{Kind: "column.delete", Target: "doing", Destination: col})
	if b.Items[itemIndex(&b, id)].ColumnID != col {
		t.Fatal("column migration")
	}
}
func TestCrossProjectAndMultiSprint(t *testing.T) {
	b := testBoard()
	b.Items[0].ProjectID = "p1"
	b.Items[1].ProjectID = "p2"
	b.Items[0].Dependencies = []string{"b"}
	b.Items[0].SprintIDs = []string{"s1", "s2"}
	b.Items[1].SprintIDs = []string{"s1"}
	mustApply(t, &b, Command{Kind: "sprint.start", Target: "s1"})
	mustApply(t, &b, Command{Kind: "sprint.start", Target: "s2"})
	// Both sprints can be active, and one shared card counts only once for WIP.
	mustApply(t, &b, Command{Kind: "item.move", Target: "a", Destination: "doing"})
	mustApply(t, &b, Command{Kind: "sprint.close", Target: "s1", Destination: "s2", Reason: "Continue"})
	if len(b.ClosedScope) != 2 {
		t.Fatal("closed scope lost")
	}
	for _, it := range b.Items {
		if !slices.Equal(it.SprintIDs, []string{"s2"}) {
			t.Fatalf("lost/duplicated memberships: %+v", it)
		}
	}
	mustApply(t, &b, Command{Kind: "sprint.close", Target: "s2", Reason: "Backlog"})
	if len(b.ClosedScope) != 4 || len(b.Items[0].SprintIDs) != 0 || len(b.Items[1].SprintIDs) != 0 {
		t.Fatal("history/backlog")
	}
	it := b.Items[0]
	it.ProjectID = ""
	mustApply(t, &b, Command{Kind: "item.update", Target: it.ID, Item: &it})
	if len(b.ClosedScope) != 4 {
		t.Fatal("editing cleared history")
	}
}
func TestCloseWithoutAdditionalSprintPreservesOtherScope(t *testing.T) {
	b := testBoard()
	b.Items[0].SprintIDs = []string{"s1", "s2"}
	b.Items[1].SprintIDs = []string{"s1"}
	b.Items[1].ColumnID = "done"
	b.Sprints[0].State = "active"
	mustApply(t, &b, Command{Kind: "sprint.close", Target: "s1", Reason: "Close only this sprint"})
	if !slices.Equal(b.Items[0].SprintIDs, []string{"s2"}) || len(b.Items[1].SprintIDs) != 0 || len(b.ClosedScope) != 2 {
		t.Fatal("closing removed another sprint")
	}
}
func TestProjectSprintColumnEdits(t *testing.T) {
	b := testBoard()
	mustApply(t, &b, Command{Kind: "project.save", Project: &Project{Name: "Third"}})
	pr := b.Projects[2]
	pr.Name = "Renamed"
	mustApply(t, &b, Command{Kind: "project.save", Target: pr.ID, Project: &pr})
	if err := Apply(&b, Command{Kind: "project.save", Target: pr.ID, Project: &pr, Revision: b.Workspace.Revision}); !errors.Is(err, ErrConflict) {
		t.Fatal("stale project accepted")
	}
	sp := b.Sprints[0]
	sp.Goal = "Updated"
	mustApply(t, &b, Command{Kind: "sprint.save", Target: sp.ID, Sprint: &sp})
	if err := Apply(&b, Command{Kind: "sprint.save", Target: sp.ID, Sprint: &sp, Revision: b.Workspace.Revision}); !errors.Is(err, ErrConflict) {
		t.Fatal("stale sprint accepted")
	}
	col := b.Columns[1]
	col.WIP = 2
	mustApply(t, &b, Command{Kind: "column.save", Target: col.ID, Column: &col})
}
