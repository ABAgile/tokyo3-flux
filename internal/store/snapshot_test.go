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
