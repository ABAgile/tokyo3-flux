package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	p "abagile.com/tokyo3/flux/internal/planning"
)

func TestDecodeBurndownBoardEnvelope(t *testing.T) {
	board := p.Board{Workspace: p.Workspace{ID: "w"}, Columns: []p.Column{}, Items: []p.Item{}, Sprints: []p.Sprint{}}
	raw, err := json.Marshal(map[string]any{"board": board})
	if err != nil {
		t.Fatal(err)
	}
	decoded := decodeBurndownBoard(raw)
	if decoded == nil || decoded.Workspace.ID != board.Workspace.ID {
		t.Fatalf("proposal board envelope was not decoded: %+v", decoded)
	}
}

func TestPostgresBurndownReadsNativeSnapshots(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	today := time.Now().UTC().Truncate(24 * time.Hour)
	sp := p.Sprint{Name: "Measured sprint", Goal: "Track delivery", Start: today.Format("2006-01-02"), End: today.AddDate(0, 0, 2).Format("2006-01-02")}
	apply(t, s, &b, p.Command{Kind: "sprint.save", Sprint: &sp})
	sprintID := b.Sprints[0].ID
	apply(t, s, &b, p.Command{Kind: "sprint.start", Target: sprintID})
	item := newItem(b, "Measured item")
	item.SprintIDs = []string{sprintID}
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &item})

	result, err := s.Burndown(context.Background(), b.Workspace.ID, "alice", sprintID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !result.HistoryAvailable || len(result.Points) != 3 || result.Points[0].Scope == nil || result.Points[0].Remaining == nil || *result.Points[0].Scope != 1 || *result.Points[0].Remaining != 1 {
		t.Fatalf("unexpected burn-down: %+v", result)
	}
}
