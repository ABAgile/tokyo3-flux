package planning

import (
	"encoding/json"
	"testing"
	"time"
)

func cloneBurndownBoard(t *testing.T, b Board) Board {
	t.Helper()
	raw, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	var clone Board
	if err = json.Unmarshal(raw, &clone); err != nil {
		t.Fatal(err)
	}
	return clone
}

func TestBuildBurndownTracksScopeAndFilters(t *testing.T) {
	b := testBoard()
	b.Members = append(b.Members, Member{Subject: "bob", Role: "member"})
	b.Sprints[0].State = "active"
	b.Items[0].ProjectID = "p1"
	b.Items[0].Assignee = "alice"
	b.Items[0].SprintIDs = []string{"s1"}
	b.Items[1].ProjectID = "p2"
	b.Items[1].Assignee = "bob"
	initial := cloneBurndownBoard(t, b)
	done := cloneBurndownBoard(t, initial)
	done.Items[0].ColumnID = "done"
	expanded := cloneBurndownBoard(t, done)
	expanded.Items[1].SprintIDs = []string{"s1"}
	snapshots := []BurndownSnapshot{
		{At: time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC), After: &initial},
		{At: time.Date(2026, 9, 2, 10, 0, 0, 0, time.UTC), Before: &initial, After: &done},
		{At: time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC), Before: &done, After: &expanded},
	}
	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	all, err := BuildBurndown(b, "s1", "all", "all", snapshots, now)
	if err != nil {
		t.Fatal(err)
	}
	if !all.HistoryAvailable || len(all.Points) != 14 {
		t.Fatalf("unexpected chart metadata: %+v", all)
	}
	want := [][2]int{{1, 1}, {1, 0}, {2, 1}, {2, 1}}
	for i, values := range want {
		if all.Points[i].Scope == nil || all.Points[i].Remaining == nil || *all.Points[i].Scope != values[0] || *all.Points[i].Remaining != values[1] {
			t.Fatalf("day %d: got %+v want %v", i, all.Points[i], values)
		}
	}
	if all.Points[4].Scope != nil || all.Points[4].Remaining != nil {
		t.Fatal("future point was invented")
	}

	filtered, err := BuildBurndown(b, "s1", "p2", "bob", snapshots, now)
	if err != nil {
		t.Fatal(err)
	}
	if *filtered.Points[0].Scope != 0 || *filtered.Points[2].Scope != 1 || *filtered.Points[2].Remaining != 1 {
		t.Fatalf("combined project/assignee filter was not applied: %+v", filtered.Points[:3])
	}
}

func TestBuildBurndownReportsMissingHistory(t *testing.T) {
	b := testBoard()
	b.Sprints[0].State = "active"
	result, err := BuildBurndown(b, "s1", "", "", nil, time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if result.HistoryAvailable || result.Points[0].Scope != nil || result.Warning == "" {
		t.Fatalf("missing history was not explicit: %+v", result)
	}
}

func TestBuildBurndownLeavesUnknownInitialDaysBlank(t *testing.T) {
	b := testBoard()
	b.Sprints[0].State = "active"
	b.Items[0].SprintIDs = []string{"s1"}
	snapshot := cloneBurndownBoard(t, b)
	result, err := BuildBurndown(b, "s1", "", "", []BurndownSnapshot{{
		At: time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC), Before: &snapshot, After: &snapshot,
	}}, time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if result.Points[0].Remaining != nil || result.Points[1].Remaining != nil || result.Points[2].Remaining == nil {
		t.Fatalf("unknown history was filled: %+v", result.Points[:3])
	}
}
