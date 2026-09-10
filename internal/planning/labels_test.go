package planning

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestLabelManagement(t *testing.T) {
	b := testBoard()
	apply := func(c Command) {
		t.Helper()
		c.Revision = b.Workspace.Revision
		if err := Apply(&b, c); err != nil {
			t.Fatal(err)
		}
	}
	apply(Command{Kind: "label.save", Name: "bug"})
	b.Items[0].Labels = []string{"bug"}
	b.Items[1].Labels = []string{"bug"}
	b.Items[1].Archived = true
	apply(Command{Kind: "label.save", Target: "bug", Name: "defect"})
	for _, it := range b.Items {
		if !slices.Equal(it.Labels, []string{"defect"}) || it.Revision != 2 {
			t.Fatal(it)
		}
	}
	apply(Command{Kind: "label.delete", Target: "defect"})
	if len(b.Labels) != 0 {
		t.Fatal(b.Labels)
	}
	for _, it := range b.Items {
		if len(it.Labels) != 0 || it.Revision != 3 {
			t.Fatal(it)
		}
	}
}

func TestLabelValidation(t *testing.T) {
	for _, c := range []Command{{Kind: "label.save", Name: " "}, {Kind: "label.save", Name: strings.Repeat("x", 61)}, {Kind: "label.save", Name: "bug"}, {Kind: "label.save", Target: "missing", Name: "new"}, {Kind: "label.delete", Target: "missing"}} {
		b := testBoard()
		b.Labels = []string{"bug"}
		c.Revision = b.Workspace.Revision
		if err := Apply(&b, c); err == nil {
			t.Fatalf("accepted %+v", c)
		}
	}
}

func TestMemberDisplayName(t *testing.T) {
	b := testBoard()
	c := Command{Kind: "member.name", Target: "alice", Name: "Alice Example", Revision: b.Workspace.Revision}
	if err := Apply(&b, c); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
	b.Role = "admin"
	if err := Apply(&b, c); err != nil {
		t.Fatal(err)
	}
	if b.Members[0].Subject != "alice" || b.Members[0].Role != "member" || b.Members[0].Name != "Alice Example" {
		t.Fatal(b.Members)
	}
}

func TestDropMoveAndOrdering(t *testing.T) {
	b := testBoard()
	if err := Apply(&b, Command{Kind: "item.move", Target: "b", Destination: "doing", Before: "a", Revision: 1}); err != nil {
		t.Fatal(err)
	}
	if b.Items[0].ID != "b" || b.Items[0].ColumnID != "doing" {
		t.Fatal(b.Items)
	}
	if err := Apply(&b, Command{Kind: "column.rank", Target: "done", Before: "ready", Revision: 2}); err != nil {
		t.Fatal(err)
	}
	if b.Columns[0].ID != "done" {
		t.Fatal(b.Columns)
	}
	if err := Apply(&b, Command{Kind: "column.rank", Target: "ready", Revision: 2}); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
}
