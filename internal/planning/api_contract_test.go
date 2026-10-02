package planning

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

var updateAPIContract = flag.Bool("update-api-contract", false, "rewrite the revision, item and read-page JSON contract fixtures")

// assertGolden compares v's indented JSON with tests/fixtures/<name>, rewriting
// it under -update-api-contract, and returns the decoded value for field checks.
func assertGolden(t *testing.T, name string, v any) any {
	t.Helper()
	actual, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	actual = append(actual, '\n')
	fixture := filepath.Join("../../tests/fixtures", name)
	if *updateAPIContract {
		if err := os.WriteFile(fixture, actual, 0644); err != nil {
			t.Fatal(err)
		}
	}
	golden, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, golden) {
		t.Fatalf("%s JSON contract drift: review the Go types and run go test ./internal/planning -run '^TestAPIJSONContract$' -update-api-contract", name)
	}
	if bytes.Contains(actual, []byte("must-not-be-exposed")) || bytes.Contains(actual, []byte("cleanup_queued")) {
		t.Fatalf("internal attachment fields leaked into %s", name)
	}
	var decoded any
	if err := json.Unmarshal(actual, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

// The CLI, Pi and the browser read these payloads too, so they are pinned the
// same way as the board: one golden file each, with every public field present.
func TestAPIJSONContract(t *testing.T) {
	board := contractBoard()

	t.Run("revision", func(t *testing.T) {
		state := WorkspaceState{Revision: board.Workspace.Revision, Role: "admin", Links: "fixture-digest"}
		decoded := assertGolden(t, "revision.json", state)
		assertBoardFields(t, reflect.TypeFor[WorkspaceState](), decoded, "revision")
	})

	t.Run("item", func(t *testing.T) {
		view := ItemView{Item: board.Items[0], Role: "admin", Revision: board.Workspace.Revision}
		decoded := assertGolden(t, "item.json", view)
		assertBoardFields(t, reflect.TypeFor[ItemView](), decoded, "item")
	})

	// Records differ per view, so each view's first page is pinned. Evidence
	// fields are omitempty by kind, so only the envelope is checked for coverage.
	t.Run("read pages", func(t *testing.T) {
		pages := map[string]ReadPage{}
		for _, view := range []string{"board", "triage", "item", "sprints", "review", "links", "imports", "catalog"} {
			target := ""
			if view == "item" {
				target = board.Items[0].ID
			}
			page, err := ReadModel(board, view, target, 0, 50, 0, contractAt.Add(time.Minute))
			if err != nil {
				t.Fatalf("%s: %v", view, err)
			}
			if len(page.Records) == 0 {
				t.Fatalf("populate the contract board so the %s view has records", view)
			}
			pages[view] = page
		}
		decoded := assertGolden(t, "read-pages.json", pages)
		for view, page := range decoded.(map[string]any) {
			assertBoardFields(t, reflect.TypeFor[ReadPage](), page, "read."+view)
		}
	})
}
