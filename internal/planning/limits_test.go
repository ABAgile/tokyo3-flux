package planning

import (
	"errors"
	"strconv"
	"testing"
)

func archivedItemIDs(b Board) []string {
	ids := []string{}
	for _, item := range b.Items {
		if item.Archived {
			ids = append(ids, item.ID)
		}
	}
	return ids
}

func fillBoard(t *testing.T, active, archived int) *Board {
	t.Helper()
	b := testBoard()
	b.Items = nil
	for i := range active {
		b.Items = append(b.Items, Item{ID: "active-" + strconv.Itoa(i), Title: "Active", ColumnID: "ready", Revision: 1})
	}
	for i := range archived {
		b.Items = append(b.Items, Item{ID: "archived-" + strconv.Itoa(i), Title: "Archived", ColumnID: "ready", Revision: 1, Archived: true})
	}
	return &b
}

// The cap bounds the live working set. Archived history must not consume it, or
// a long-lived workspace loses the ability to create work with no way back.
func TestItemCreateCapCountsOnlyActiveItems(t *testing.T) {
	b := fillBoard(t, MaxItems-1, 500)
	mustApply(t, b, Command{Kind: "item.create", Item: &Item{Title: "Fits", ColumnID: "ready"}})
	if count := activeItemCount(b); count != MaxItems {
		t.Fatalf("active items = %d, want %d", count, MaxItems)
	}
	err := Apply(b, Command{Kind: "item.create", Revision: b.Workspace.Revision, Item: &Item{Title: "Over", ColumnID: "ready"}})
	if !errors.Is(err, ErrInvalid) {
		t.Errorf("creating past the active cap = %v, want ErrInvalid", err)
	}
}

// Restoring returns an item to the live set, so it must honour the same cap
// rather than silently exceeding it.
func TestItemRestoreRespectsActiveCap(t *testing.T) {
	b := fillBoard(t, MaxItems, 1)
	target := b.Items[len(b.Items)-1].ID
	err := Apply(b, Command{Kind: "item.restore", Revision: b.Workspace.Revision, Target: target})
	if !errors.Is(err, ErrInvalid) {
		t.Errorf("restore past the active cap = %v, want ErrInvalid", err)
	}
}

func TestItemRestoreAllowedBelowActiveCap(t *testing.T) {
	b := fillBoard(t, 2, 1)
	target := b.Items[len(b.Items)-1].ID
	mustApply(t, b, Command{Kind: "item.restore", Target: target})
	if got := archivedItemIDs(*b); len(got) != 0 {
		t.Errorf("item was not restored: %v", got)
	}
}
