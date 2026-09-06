package report

import (
	"strings"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/state"
)

func TestReportsCombineCurrentHistoryAndHumanOverlay(t *testing.T) {
	asOf := time.Date(2026, time.June, 10, 12, 0, 0, 0, time.UTC)
	store, err := state.OpenFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	initial := reportSnapshot(asOf.Add(-time.Hour), false)
	if err := store.PutObserved(initial, "run-1", asOf.Add(-time.Hour)); err != nil {
		t.Fatalf("PutObserved(initial) error = %v", err)
	}
	current := reportSnapshot(asOf, true)
	if err := store.PutObserved(current, "run-2", asOf); err != nil {
		t.Fatalf("PutObserved(current) error = %v", err)
	}
	from := asOf.Add(-2 * time.Hour)
	until := asOf.Add(time.Hour)
	for _, context := range []domain.HumanContext{
		{
			ID:             "context-1",
			Revision:       1,
			Kind:           domain.ContextKindDelayExplanation,
			Status:         domain.ContextStatusConfirmed,
			Confidence:     domain.ContextConfidenceConfirmed,
			CreatedAt:      asOf.Add(-time.Hour),
			UpdatedAt:      asOf.Add(-time.Hour),
			Statement:      "A review dependency is pending.",
			Category:       "dependency",
			Milestone:      "Flow 01",
			ReportingFrom:  &from,
			ReportingUntil: &until,
		},
		{
			ID:             "context-2",
			Revision:       1,
			Kind:           domain.ContextKindScopeChange,
			Status:         domain.ContextStatusConfirmed,
			Confidence:     domain.ContextConfidenceConfirmed,
			CreatedAt:      asOf.Add(-time.Hour),
			UpdatedAt:      asOf.Add(-time.Hour),
			Statement:      "Another milestone has a separate scope decision.",
			Category:       "scope",
			Milestone:      "Flow 99",
			ReportingFrom:  &from,
			ReportingUntil: &until,
		},
	} {
		if err := store.RecordContext(context); err != nil {
			t.Fatalf("RecordContext(%s) error = %v", context.ID, err)
		}
	}

	reports, err := New(Config{
		Snapshot:   store,
		History:    store,
		Flow:       store,
		Context:    store,
		StaleAfter: 7 * 24 * time.Hour,
		Now:        func() time.Time { return asOf },
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defaultValue, err := reports.Generate(KindStandup, Query{Limit: 10})
	if err != nil {
		t.Fatalf("Generate(default standup) error = %v", err)
	}
	if len(defaultValue.(StandupReport).RecentChanges) == 0 {
		t.Fatal("default standup recent changes = 0, want latest observed changes")
	}
	standupValue, err := reports.Generate(KindStandup, Query{From: asOf.Add(-2 * time.Hour), Until: asOf.Add(time.Hour), Limit: 10})
	if err != nil {
		t.Fatalf("Generate(standup) error = %v", err)
	}
	standup, ok := standupValue.(StandupReport)
	if !ok {
		t.Fatalf("standup type = %T, want StandupReport", standupValue)
	}
	if standup.Kind != KindStandup || standup.Milestone != "Flow 01" || standup.Counts[string(domain.StatusDone)] != 1 || len(standup.Completed) != 1 || len(standup.Attention) != 5 {
		t.Fatalf("standup = %+v", standup)
	}
	if len(standup.RecentChanges) == 0 || len(standup.HumanContext.Entries) != 1 || standup.Coverage.History == nil || standup.Coverage.HumanContext == nil {
		t.Fatalf("standup evidence = %+v", standup)
	}
	foundChangedItem := false
	for _, change := range standup.RecentChanges {
		if change.ItemID == "team/project#2" {
			foundChangedItem = true
			break
		}
	}
	if !foundChangedItem {
		t.Fatalf("standup recent changes = %+v, want item #2 change", standup.RecentChanges)
	}
	if len(standup.Coverage.Sources) != 3 || len(standup.Coverage.Uncertainties) == 0 {
		t.Fatalf("standup coverage = %+v", standup.Coverage)
	}

	for _, kind := range Kinds() {
		value, err := reports.Generate(kind, Query{From: asOf.Add(-2 * time.Hour), Until: asOf.Add(time.Hour), Limit: 2})
		if err != nil {
			t.Fatalf("Generate(%s) error = %v", kind, err)
		}
		var output strings.Builder
		if err := RenderText(&output, value); err != nil {
			t.Fatalf("RenderText(%s) error = %v", kind, err)
		}
		if !strings.Contains(output.String(), "Evidence:") || !strings.Contains(output.String(), "Human-reported overlay") {
			t.Fatalf("RenderText(%s) = %q", kind, output.String())
		}
	}
}

func TestBacklogRetainsFullCountsWhenListsAreBounded(t *testing.T) {
	asOf := time.Date(2026, time.July, 1, 12, 0, 0, 0, time.UTC)
	store := state.NewMemoryStore()
	items := []domain.WorkItem{
		{ID: "team/project#1", ProjectID: 1, ProjectPath: "team/project", Title: "One", State: domain.IssueOpen},
		{ID: "team/project#2", ProjectID: 1, ProjectPath: "team/project", Title: "Two", State: domain.IssueOpen},
		{ID: "team/project#3", ProjectID: 1, ProjectPath: "team/project", Title: "Three", State: domain.IssueOpen},
	}
	store.Put(domain.Snapshot{GeneratedAt: asOf, Sprint: domain.Sprint{Name: "Flow 02", WorkItems: items}})
	reports, err := New(Config{Snapshot: store, Now: func() time.Time { return asOf }})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	value, err := reports.Generate(KindBacklog, Query{Limit: 1})
	if err != nil {
		t.Fatalf("Generate(backlog) error = %v", err)
	}
	backlog := value.(BacklogReport)
	if backlog.Total != 3 || len(backlog.Items) != 1 || len(backlog.Buckets) != 1 || backlog.Buckets[0].Count != 3 || len(backlog.Buckets[0].ItemIDs) != 1 || !backlog.Truncated {
		t.Fatalf("bounded backlog = %+v", backlog)
	}
	if len(backlog.Coverage.Uncertainties) == 0 {
		t.Fatalf("bounded backlog coverage = %+v, want uncertainty", backlog.Coverage)
	}
}

func TestReportsMarkMissingEvidence(t *testing.T) {
	asOf := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	store := state.NewMemoryStore()
	store.Put(domain.Snapshot{GeneratedAt: asOf, Sprint: domain.Sprint{Name: "Flow 03"}})
	reports, err := New(Config{Snapshot: store, Now: func() time.Time { return asOf }})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	value, err := reports.Generate(KindSprintHealth, Query{})
	if err != nil {
		t.Fatalf("Generate(sprint health) error = %v", err)
	}
	health := value.(SprintHealthReport)
	if health.Coverage.History != nil || health.Coverage.HumanContext != nil || len(health.HumanContext.Uncertainties) == 0 {
		t.Fatalf("missing evidence = %+v", health)
	}
	if !strings.Contains(strings.Join(health.Coverage.Uncertainties, " "), "unavailable") {
		t.Fatalf("missing evidence uncertainties = %+v", health.Coverage.Uncertainties)
	}
}

func TestParseKindAndQueryBounds(t *testing.T) {
	for _, raw := range []string{"standup", "sprint-health", "sprint_health", "retrospective"} {
		if _, err := ParseKind(raw); err != nil {
			t.Errorf("ParseKind(%q) error = %v", raw, err)
		}
	}
	if _, err := ParseKind("unknown"); err == nil {
		t.Fatal("ParseKind(unknown) error = nil")
	}
	store := state.NewMemoryStore()
	asOf := time.Date(2026, time.August, 2, 12, 0, 0, 0, time.UTC)
	store.Put(domain.Snapshot{GeneratedAt: asOf, Sprint: domain.Sprint{Name: "Flow 04"}})
	reports, err := New(Config{Snapshot: store, Now: func() time.Time { return asOf }})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := reports.Generate(KindStandup, Query{Limit: MaxLimit + 1}); err == nil {
		t.Fatal("oversized report limit error = nil")
	}
	if _, err := reports.Generate(KindStandup, Query{From: asOf, Until: asOf}); err == nil {
		t.Fatal("invalid report window error = nil")
	}
}

func reportSnapshot(at time.Time, changed bool) domain.Snapshot {
	title := "Unassigned work"
	if changed {
		title = "Unassigned work updated"
	}
	return domain.Snapshot{
		GeneratedAt: at,
		Sprint: domain.Sprint{
			Name: "Flow 01",
			Goal: "Ship visible delivery",
			WorkItems: []domain.WorkItem{
				{ID: "team/project#1", ProjectID: 1, ProjectPath: "team/project", Title: "Done work", State: domain.IssueClosed, LastActivity: at},
				{ID: "team/project#2", ProjectID: 1, ProjectPath: "team/project", Title: title, State: domain.IssueOpen, LastActivity: at},
				{ID: "team/project#3", ProjectID: 1, ProjectPath: "team/project", Title: "Active work", State: domain.IssueOpen, Assignee: "alex", LastActivity: at},
				{ID: "team/project#4", ProjectID: 1, ProjectPath: "team/project", Title: "Blocked work", State: domain.IssueOpen, Assignee: "alex", Blocked: true, LastActivity: at},
				{ID: "team/project#5", ProjectID: 1, ProjectPath: "team/project", Title: "Review work", State: domain.IssueOpen, Assignee: "alex", LastActivity: at, MergeRequests: []domain.MergeRequest{{ID: "!5", State: domain.MergeRequestOpen, ReviewRequested: true}}},
				{ID: "team/project#6", ProjectID: 1, ProjectPath: "team/project", Title: "Pipeline work", State: domain.IssueOpen, Assignee: "alex", LastActivity: at, MergeRequests: []domain.MergeRequest{{ID: "!6", State: domain.MergeRequestOpen, Pipeline: domain.PipelineFailed}}},
				{ID: "team/project#7", ProjectID: 1, ProjectPath: "team/project", Title: "Stale work", State: domain.IssueOpen, Assignee: "alex", LastActivity: at.Add(-10 * 24 * time.Hour)},
			},
		},
	}
}
