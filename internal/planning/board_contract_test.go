package planning

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

var updateBoardContract = flag.Bool("update-board-contract", false, "rewrite the shared board JSON contract fixture")

// This fully populated board exercises optional fields as well as the fields
// always sent by /api/v2. TypeScript checks this same file against Flux.Board;
// Node tests reuse it as real Go-shaped input rather than handwritten mocks.
func TestBoardJSONContract(t *testing.T) {
	at := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	target := LinkTarget{Project: 42, Kind: "mr", Number: 7}
	board := Board{
		Workspace: Workspace{ID: "workspace-one", Name: "Contract team", Role: "admin", Revision: 4},
		Role:      "admin", RefreshSeconds: 30, ConnectorInstance: "https://gitlab.example",
		Integration: Integration{Instance: "https://gitlab.example", Projects: []int64{42}},
		Imported:    []ImportReceipt{{Source: "fixture", ItemID: "item-one", ProposalID: "proposal-one"}},
		Projects:    []Project{{ID: "project-one", WorkspaceID: "workspace-one", Name: "Project", Revision: 1}},
		Columns:     []Column{{ID: "todo", Name: "To do", Category: "todo", Position: 0, WIP: 5}},
		Items: []Item{{ID: "item-one", Title: "Contract item", Description: "**Shared** planning",
			StartDate: "2026-09-10", EndDate: "2026-09-20", DueDate: "2026-09-18", ColumnID: "todo",
			ProjectID: "project-one", ProjectIDs: []string{"project-one"}, SprintIDs: []string{"sprint-one"},
			Assignee: "7", Rank: 0, Revision: 2, Archived: false, Labels: []string{"bug"}, Dependencies: []string{},
			AttachmentCount: 1, Attachments: []Attachment{{ID: 1, ItemID: "item-one", Name: "notes.txt",
				ContentType: "text/plain", Size: 12, Digest: "fixture-digest", Uploader: "7", CreatedAt: at,
				StorageKey: "must-not-be-exposed", CleanupQueued: true}}}},
		Sprints: []Sprint{{ID: "sprint-one", Name: "Sprint", Goal: "Verify contracts", Start: "2026-09-10",
			End: "2026-09-20", State: "active", Revision: 1}},
		Labels: []Label{{Name: "bug", Color: "#ffcc00"}},
		Members: []Member{{Subject: "7", Name: "Team member", Role: "admin", Username: "member",
			AvatarURL: "https://gitlab.example/avatar/7.png"}},
		ClosedScope: []Scope{{SprintID: "closed-sprint", ItemID: "item-one"}},
		Participants: []Participant{{ItemID: "item-one", Subject: "42", Roles: []string{"reviewer"},
			Name: "Reviewer", Username: "reviewer", AvatarURL: "https://gitlab.example/avatar/42.png"}},
		Links: []ExternalLink{{ID: "link-one", LinkTarget: target,
			Items: []string{"item-one"}, RefreshPending: false, Outcome: "success", LastSuccess: &at,
			LastAttempt: &at, NextRefresh: &at, Observation: &Observation{
				SourceUpdatedAt: &at, URL: "https://gitlab.example/team/project/-/merge_requests/7", Title: "MR",
				MRState: "opened", Draft: false, Review: "approved", HeadSHA: "head-a",
				Pipeline: &Pipeline{ID: 12, URL: "https://gitlab.example/team/project/-/pipelines/12", SHA: "head-a",
					State: "success", ProviderState: "success", CurrentHead: true, SourceUpdatedAt: &at},
				Reviewers: []Reviewer{{ID: 42, Name: "Reviewer", Username: "reviewer", AvatarURL: "https://gitlab.example/avatar/42.png"}},
			}}},
	}
	actual, err := json.MarshalIndent(board, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	actual = append(actual, '\n')
	const fixture = "../../tests/fixtures/board.json"
	if *updateBoardContract {
		if err := os.MkdirAll("../../tests/fixtures", 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fixture, actual, 0644); err != nil {
			t.Fatal(err)
		}
	}
	golden, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, golden) {
		t.Fatal("board JSON contract drift: review the Go/Flux types and run go test ./internal/planning -run '^TestBoardJSONContract$' -update-board-contract")
	}
	var decoded any
	if err := json.Unmarshal(actual, &decoded); err != nil {
		t.Fatal(err)
	}
	assertBoardFields(t, reflect.TypeFor[Board](), decoded, "board")
	if bytes.Contains(actual, []byte("must-not-be-exposed")) || bytes.Contains(actual, []byte("cleanup_queued")) {
		t.Fatal("internal attachment fields leaked into JSON")
	}
}

// Catch newly added omitempty fields even when an unchanged sample would omit
// them. Every public struct field must be populated in the golden fixture.
func assertBoardFields(t *testing.T, typ reflect.Type, value any, path string) {
	t.Helper()
	if typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	if typ == reflect.TypeFor[time.Time]() {
		return
	}
	if typ.Kind() == reflect.Slice {
		if typ.Elem().Kind() == reflect.Struct {
			rows, ok := value.([]any)
			if !ok || len(rows) == 0 {
				t.Fatalf("populate %s for field coverage", path)
			}
			assertBoardFields(t, typ.Elem(), rows[0], path+"[]")
		}
		return
	}
	if typ.Kind() != reflect.Struct {
		return
	}
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("populate %s for field coverage", path)
	}
	for field := range typ.Fields() {
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name == "-" || !field.IsExported() {
			continue
		}
		if name == "" && field.Anonymous {
			assertBoardFields(t, field.Type, value, path)
			continue
		}
		if name == "" {
			name = field.Name
		}
		child, exists := object[name]
		if !exists {
			t.Fatalf("populate %s.%s in the board contract fixture", path, name)
		}
		assertBoardFields(t, field.Type, child, path+"."+name)
	}
}
