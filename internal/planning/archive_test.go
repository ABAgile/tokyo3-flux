package planning

import (
	"slices"
	"testing"
)

// An archived item nothing references is withheld from the board payload; the
// archive endpoint is the way to reach it.
func TestBrowserBoardDropsInertArchivedItems(t *testing.T) {
	b := testBoard()
	b.Items = append(b.Items, Item{ID: "old", Title: "Old", ColumnID: "ready", Revision: 1, Archived: true})
	got := BrowserBoard(b)
	if slices.ContainsFunc(got.Items, func(item Item) bool { return item.ID == "old" }) {
		t.Error("inert archived item should not ship with the board")
	}
	if len(got.Items) != 2 {
		t.Errorf("live items = %d, want 2", len(got.Items))
	}
}

// Closed sprint scope is rendered from the board payload, so archived items it
// names must survive the filter or the scope view silently loses rows.
func TestBrowserBoardKeepsClosedScopeArchivedItems(t *testing.T) {
	b := testBoard()
	b.Items = append(b.Items, Item{ID: "old", Title: "Old", ColumnID: "done", Revision: 1, Archived: true})
	b.ClosedScope = []Scope{{SprintID: "s1", ItemID: "old"}}
	if got := archivedItemIDs(BrowserBoard(b)); !slices.Equal(got, []string{"old"}) {
		t.Errorf("retained archived items = %v, want [old]", got)
	}
}

// blocked() resolves dependency targets client-side, including transitively
// through retained archived items.
func TestBrowserBoardKeepsDependencyTargetsTransitively(t *testing.T) {
	b := testBoard()
	b.Items[0].Dependencies = []string{"gone"}
	b.Items = append(b.Items,
		Item{ID: "gone", Title: "Gone", ColumnID: "ready", Revision: 1, Archived: true, Dependencies: []string{"deeper"}},
		Item{ID: "deeper", Title: "Deeper", ColumnID: "ready", Revision: 1, Archived: true},
		Item{ID: "inert", Title: "Inert", ColumnID: "ready", Revision: 1, Archived: true})
	got := archivedItemIDs(BrowserBoard(b))
	slices.Sort(got)
	if !slices.Equal(got, []string{"deeper", "gone"}) {
		t.Errorf("retained archived items = %v, want [deeper gone]", got)
	}
}

func TestBrowserBoardLeavesSourceUnchanged(t *testing.T) {
	b := testBoard()
	b.Items = append(b.Items, Item{ID: "old", Title: "Old", ColumnID: "ready", Revision: 1, Archived: true})
	BrowserBoard(b)
	if len(b.Items) != 3 {
		t.Errorf("source board items = %d, want 3; BrowserBoard must not mutate its input", len(b.Items))
	}
}
