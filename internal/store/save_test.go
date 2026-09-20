package store

import (
	"context"
	"strconv"
	"strings"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// recordingTx captures the statements save emits. save and saveIntegration use
// only Exec, so the remaining pgx.Tx methods stay unimplemented on purpose: a
// future change that starts querying inside save fails loudly here.
type recordingTx struct {
	pgx.Tx
	statements []string
}

func (t *recordingTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	t.statements = append(t.statements, strings.Join(strings.Fields(sql), " "))
	return pgconn.CommandTag{}, nil
}

func (t *recordingTx) count(substring string) int {
	total := 0
	for _, statement := range t.statements {
		if strings.Contains(statement, substring) {
			total++
		}
	}
	return total
}

// index returns the position of the first statement containing substring, or -1.
func (t *recordingTx) index(substring string) int {
	for i, statement := range t.statements {
		if strings.Contains(statement, substring) {
			return i
		}
	}
	return -1
}

func testBoard(items int) p.Board {
	b := p.Board{
		Workspace: p.Workspace{ID: "w1", Name: "Workspace", Revision: 7},
		Columns: []p.Column{
			{ID: "c1", Name: "Ready", Category: "todo"},
			{ID: "c2", Name: "Doing", Category: "doing", Position: 1},
		},
		Projects:    []p.Project{{ID: "p1", WorkspaceID: "w1", Name: "Platform", Revision: 1}},
		Labels:      []p.Label{{Name: "type::bug", Color: "#dcefe4"}},
		Sprints:     []p.Sprint{{ID: "s1", Name: "Sprint 1", Goal: "Ship", Start: "2024-01-01", End: "2024-01-14", State: "active", Revision: 1}},
		ClosedScope: []p.Scope{},
		Items:       make([]p.Item, items),
	}
	for i := range b.Items {
		id := "i" + strconv.Itoa(i)
		b.Items[i] = p.Item{
			ID: id, Title: "Item " + id, ColumnID: "c1", Rank: i, Revision: 1,
			ProjectID: "p1", ProjectIDs: []string{"p1"}, SprintIDs: []string{"s1"},
			Labels: []string{"type::bug"}, Dependencies: []string{},
		}
	}
	return b
}

func saveDiff(t *testing.T, mutate func(b *p.Board)) *recordingTx {
	t.Helper()
	before := testBoard(500)
	next := cloneSaveState(before)
	mutate(&next)
	next.Workspace.Revision++
	tx := &recordingTx{}
	if err := save(context.Background(), tx, before, next); err != nil {
		t.Fatalf("save: %v", err)
	}
	return tx
}

// An unchanged board must not rewrite any planning row. This is the regression
// guard for write cost scaling with workspace size instead of change size.
func TestSaveWritesNothingWhenPlanningIsUnchanged(t *testing.T) {
	tx := saveDiff(t, func(*p.Board) {})
	for _, table := range []string{"INTO work_items", "INTO item_labels", "INTO item_projects", "INTO item_sprints", "INTO dependencies", "INTO board_columns", "INTO sprints", "INTO projects", "INTO workspace_labels"} {
		if got := tx.count(table); got != 0 {
			t.Errorf("unchanged board wrote %d rows to %q", got, table)
		}
	}
	if got := tx.count("DELETE FROM item_labels"); got != 0 {
		t.Errorf("unchanged board deleted %d item_labels rows", got)
	}
	if got := tx.count("UPDATE workspaces SET revision"); got != 1 {
		t.Errorf("workspace revision updates = %d, want 1", got)
	}
}

// Moving one card must cost a constant number of statements regardless of how
// many other items the workspace holds.
func TestSaveMovingOneItemTouchesOnlyThatItem(t *testing.T) {
	tx := saveDiff(t, func(b *p.Board) {
		b.Items[3].ColumnID = "c2"
		b.Items[3].Revision++
	})
	if got := tx.count("INTO work_items"); got != 1 {
		t.Errorf("work_items upserts = %d, want 1", got)
	}
	for _, table := range []string{"item_labels", "item_projects", "item_sprints", "dependencies"} {
		if got := tx.count(table); got != 0 {
			t.Errorf("moving an item touched %q %d times", table, got)
		}
	}
}

// Reordering rewrites every item whose rank changed, but nothing else.
func TestSaveReorderWritesOnlyRankedItems(t *testing.T) {
	tx := saveDiff(t, func(b *p.Board) {
		item := b.Items[0]
		b.Items = append(b.Items[1:], item)
		for i := range b.Items {
			b.Items[i].Rank = i
		}
	})
	if got := tx.count("INTO work_items"); got != 500 {
		t.Errorf("work_items upserts = %d, want 500", got)
	}
	if got := tx.count("INTO item_labels"); got != 0 {
		t.Errorf("reorder rewrote %d item_labels rows", got)
	}
}

// A renamed label must drop item_labels rows before the catalog row they
// reference, and re-add them only after the new catalog row exists.
func TestSaveLabelRenameOrdersCatalogAgainstItemRows(t *testing.T) {
	tx := saveDiff(t, func(b *p.Board) {
		b.Labels[0] = p.Label{Name: "type::defect", Color: "#dcefe4"}
		for i := range b.Items {
			b.Items[i].Labels = []string{"type::defect"}
			b.Items[i].Revision++
		}
	})
	deleteItemLabels := tx.index("DELETE FROM item_labels")
	deleteCatalog := tx.index("DELETE FROM workspace_labels")
	insertCatalog := tx.index("INTO workspace_labels")
	insertItemLabels := tx.index("INTO item_labels")
	if deleteItemLabels < 0 || deleteCatalog < 0 || insertCatalog < 0 || insertItemLabels < 0 {
		t.Fatalf("missing statements: %v", tx.statements)
	}
	if deleteItemLabels > deleteCatalog {
		t.Error("item_labels rows must be deleted before the workspace_labels row they reference")
	}
	if insertCatalog > insertItemLabels {
		t.Error("workspace_labels row must exist before item_labels rows reference it")
	}
}

// Deleting a column reassigns its items; the column row may only be dropped
// after every referencing work_items row has moved.
func TestSaveDeletesColumnAfterItemsMove(t *testing.T) {
	tx := saveDiff(t, func(b *p.Board) {
		b.Columns = b.Columns[:1]
		for i := range b.Items {
			b.Items[i].ColumnID = "c1"
		}
	})
	deleteColumn := tx.index("DELETE FROM board_columns")
	if deleteColumn < 0 {
		t.Fatalf("removed column was not deleted: %v", tx.statements)
	}
	if upsert := tx.index("INTO work_items"); upsert >= 0 && upsert > deleteColumn {
		t.Error("work_items must be moved off a column before the column is deleted")
	}
}

// Items are archived, never removed, so a vanished item means the caller
// applied something save cannot persist coherently. Clearing the child rows
// would strand the parent work_items row as a half-deleted card, so the
// transaction must fail instead and leave the workspace untouched.
func TestSaveRefusesRemovedItems(t *testing.T) {
	before := testBoard(500)
	next := cloneSaveState(before)
	removed := next.Items[0].ID
	next.Items = next.Items[1:]
	next.Workspace.Revision++
	tx := &recordingTx{}
	err := save(context.Background(), tx, before, next)
	if err == nil {
		t.Fatal("save accepted an item removal")
	}
	if !strings.Contains(err.Error(), removed) {
		t.Errorf("error does not name the vanished item: %v", err)
	}
	for _, table := range []string{"DELETE FROM item_labels", "DELETE FROM item_projects", "DELETE FROM item_sprints", "DELETE FROM dependencies"} {
		if got := tx.count(table); got != 0 {
			t.Errorf("refused save still withdrew %d rows from %q", got, table)
		}
	}
}

// cloneSaveState must not alias the loaded board, or Apply's in-place mutation
// would silently erase the diff baseline.
func TestCloneSaveStateIsIndependent(t *testing.T) {
	before := testBoard(2)
	clone := cloneSaveState(before)
	before.Items[0].Labels[0] = "mutated"
	before.Items[0].SprintIDs[0] = "mutated"
	before.Items[0].ProjectIDs[0] = "mutated"
	before.Columns[0].Name = "mutated"
	before.Labels[0].Name = "mutated"
	if clone.Items[0].Labels[0] != "type::bug" || clone.Items[0].SprintIDs[0] != "s1" || clone.Items[0].ProjectIDs[0] != "p1" {
		t.Error("clone shares item association backing arrays with the loaded board")
	}
	if clone.Columns[0].Name != "Ready" || clone.Labels[0].Name != "type::bug" {
		t.Error("clone shares column or label storage with the loaded board")
	}
}

func TestSaveNewItemWritesItsAssociations(t *testing.T) {
	tx := saveDiff(t, func(b *p.Board) {
		b.Items = append(b.Items, p.Item{
			ID: "new", Title: "New", ColumnID: "c1", Rank: len(b.Items), Revision: 1,
			ProjectIDs: []string{"p1"}, SprintIDs: []string{"s1"}, Labels: []string{"type::bug"},
		})
	})
	if got := tx.count("INTO work_items"); got != 1 {
		t.Errorf("work_items upserts = %d, want 1", got)
	}
	for _, table := range []string{"INTO item_labels", "INTO item_projects", "INTO item_sprints"} {
		if got := tx.count(table); got != 1 {
			t.Errorf("%q inserts = %d, want 1", table, got)
		}
	}
}
