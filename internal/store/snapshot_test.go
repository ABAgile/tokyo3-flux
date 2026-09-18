package store

import (
	"encoding/json"
	"strings"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

func TestPlanningSnapshotOmitsAttachments(t *testing.T) {
	board := p.Board{Items: []p.Item{{ID: "item", Attachments: []p.Attachment{{ID: 1, Name: "secret.txt"}}}}}
	raw, err := json.Marshal(planningSnapshot(board))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "secret.txt") || strings.Contains(string(raw), "attachments") {
		t.Fatalf("attachment metadata entered planning snapshot: %s", raw)
	}
}

func TestPlanningSnapshotOmitsDescriptionsAndKeepsPlanningState(t *testing.T) {
	board := p.Board{Items: []p.Item{{
		ID: "item", Title: "Ship the board", Description: "very long prose",
		ColumnID: "col", Assignee: "7", SprintIDs: []string{"sprint"},
	}}}
	snapshot := planningSnapshot(board)
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "very long prose") {
		t.Fatalf("description entered planning snapshot: %s", raw)
	}
	for _, want := range []string{"Ship the board", "col", "sprint"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("planning snapshot dropped %q: %s", want, raw)
		}
	}
	if board.Items[0].Description != "very long prose" {
		t.Fatal("planning snapshot mutated the caller's board")
	}
}
