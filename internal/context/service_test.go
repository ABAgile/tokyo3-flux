package humancontext

import (
	"context"
	"errors"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/state"
)

func TestServicePlansAndConfirmsOnce(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	store, err := state.OpenFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	service, err := New(Config{Store: store, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	from := now.Add(-time.Hour)
	until := now.Add(time.Hour)
	plan, err := service.Plan(Input{
		Kind:           domain.ContextKindDelayExplanation,
		Statement:      "  Review\nneeds a dependency. ",
		Category:       "DEPENDENCY",
		ItemIDs:        []string{"team/project#12", "team/project#12"},
		ReportingFrom:  &from,
		ReportingUntil: &until,
		SourceURLs:     []string{"https://gitlab.example.com/team/project/-/issues/12"},
	}, Actor{Subject: "user-1", Name: "Alex"})
	if err != nil {
		t.Fatalf("Plan() error = %v", err)
	}
	if plan.ID == "" || plan.Confirmation == "" || plan.Entry.Status != domain.ContextStatusProposed || plan.Entry.Confidence != domain.ContextConfidenceProposed || plan.Entry.Statement != "Review needs a dependency." || plan.Entry.Category != "dependency" {
		t.Fatalf("plan = %+v", plan)
	}
	before, err := store.ListContext(state.ContextQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ListContext before confirm error = %v", err)
	}
	if len(before.Entries) != 0 {
		t.Fatalf("planned entries = %+v, want none", before.Entries)
	}
	entry, err := service.Confirm(context.Background(), plan.ID, plan.Confirmation, Actor{Subject: "user-1"})
	if err != nil {
		t.Fatalf("Confirm() error = %v", err)
	}
	if entry.ID != plan.ID || entry.AuthorSubject != "user-1" || entry.Status != domain.ContextStatusConfirmed || entry.Confidence != domain.ContextConfidenceConfirmed || entry.ContentHash == "" {
		t.Fatalf("confirmed entry = %+v", entry)
	}
	result, err := store.ListContext(state.ContextQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ListContext after confirm error = %v", err)
	}
	if len(result.Entries) != 1 || result.Entries[0].ID != plan.ID {
		t.Fatalf("confirmed entries = %+v", result.Entries)
	}
	if _, err := service.Confirm(context.Background(), plan.ID, plan.Confirmation, Actor{Subject: "user-1"}); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("second Confirm() error = %v, want ErrPlanNotFound", err)
	}
}

func TestServiceRejectsInvalidContext(t *testing.T) {
	store, err := state.OpenFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	service, err := New(Config{Store: store})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	until := now.Add(time.Hour)
	cases := []Input{
		{Kind: "unknown", Statement: "statement", Category: "other", ReportingFrom: &now, ReportingUntil: &until},
		{Kind: domain.ContextKindDelayExplanation, Statement: "", Category: "other", ReportingFrom: &now, ReportingUntil: &until},
		{Kind: domain.ContextKindDelayExplanation, Statement: "statement", Category: "unknown", ReportingFrom: &now, ReportingUntil: &until},
		{Kind: domain.ContextKindDelayExplanation, Statement: "statement", Category: "other", ReportingFrom: &until, ReportingUntil: &now},
		{Kind: domain.ContextKindScopeChange, Statement: "statement", Category: "scope", ScopeAction: "add", ReportingFrom: &now, ReportingUntil: &until},
		{Kind: domain.ContextKindDelayExplanation, Statement: "statement", Category: "other", ReportingFrom: &now, ReportingUntil: &until, SourceURLs: []string{"file:///tmp/evidence"}},
	}
	for index, input := range cases {
		if _, err := service.Plan(input, Actor{Subject: "user-1"}); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("case %d Plan() error = %v, want ErrInvalidInput", index, err)
		}
	}
	if _, err := service.Plan(cases[1], Actor{}); !errors.Is(err, ErrActorRequired) {
		t.Fatalf("missing actor error = %v, want ErrActorRequired", err)
	}
}

func TestServiceCorrectionAndRedaction(t *testing.T) {
	store, err := state.OpenFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	service, err := New(Config{Store: store, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	until := now.Add(time.Hour)
	original, err := service.Plan(Input{Kind: domain.ContextKindDelayExplanation, Statement: "The first explanation.", Category: "dependency", ReportingFrom: &now, ReportingUntil: &until}, Actor{Subject: "user-1"})
	if err != nil {
		t.Fatalf("original Plan() error = %v", err)
	}
	if _, err := service.Confirm(context.Background(), original.ID, original.Confirmation, Actor{Subject: "user-1"}); err != nil {
		t.Fatalf("original Confirm() error = %v", err)
	}
	correction, err := service.Plan(Input{Kind: domain.ContextKindDelayExplanation, Statement: "The corrected explanation.", Category: "review", SupersedesID: original.Entry.ID, ReportingFrom: &now, ReportingUntil: &until}, Actor{Subject: "user-2"})
	if err != nil {
		t.Fatalf("correction Plan() error = %v", err)
	}
	if correction.Operation != "correction" || correction.Entry.ID != original.Entry.ID || correction.Entry.Revision != 2 || correction.OriginalHash == "" {
		t.Fatalf("correction plan = %+v", correction)
	}
	if _, err := service.Confirm(context.Background(), correction.ID, correction.Confirmation, Actor{Subject: "user-2"}); err != nil {
		t.Fatalf("correction Confirm() error = %v", err)
	}
	history, err := store.ContextHistory(original.Entry.ID)
	if err != nil {
		t.Fatalf("ContextHistory() error = %v", err)
	}
	if len(history.Revisions) != 2 || history.Revisions[1].Statement != "The corrected explanation." || len(history.Audits) != 2 || history.Audits[1].Action != "correction" || history.Audits[1].OriginalHash != original.Entry.ContentHash {
		t.Fatalf("corrected history = %+v", history)
	}

	redaction, err := service.PlanRedaction(original.Entry.ID, Actor{Subject: "user-2"})
	if err != nil {
		t.Fatalf("PlanRedaction() error = %v", err)
	}
	if redaction.Operation != "redact" || redaction.Entry.Status != domain.ContextStatusProposed {
		t.Fatalf("redaction plan = %+v", redaction)
	}
	if _, err := service.Confirm(context.Background(), redaction.ID, redaction.Confirmation, Actor{Subject: "user-2"}); err != nil {
		t.Fatalf("redaction Confirm() error = %v", err)
	}
	result, err := store.ListContext(state.ContextQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ListContext after redaction error = %v", err)
	}
	if len(result.Entries) != 0 {
		t.Fatalf("redacted current entries = %+v, want none", result.Entries)
	}
	history, err = store.ContextHistory(original.Entry.ID)
	if err != nil {
		t.Fatalf("redacted ContextHistory() error = %v", err)
	}
	for _, entry := range history.Revisions {
		if entry.Statement != "[redacted]" || entry.Milestone != "" || len(entry.SourceURLs) != 0 || entry.AuthorSubject != "" || entry.ContentHash != "" {
			t.Fatalf("redacted revision still contains context = %+v", entry)
		}
	}
	if len(history.Audits) != 3 || history.Audits[2].Action != "redact" || history.Audits[2].ActorSubject != "user-2" || history.Audits[2].OriginalHash == "" {
		t.Fatalf("redaction audits = %+v", history.Audits)
	}
}

func TestServiceRedactionAuthorization(t *testing.T) {
	store, err := state.OpenFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	service, err := New(Config{Store: store, RedactSubjects: []string{"admin"}, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	until := now.Add(time.Hour)
	plan, err := service.Plan(Input{Kind: domain.ContextKindDelayExplanation, Statement: "A report.", Category: "other", ReportingFrom: &now, ReportingUntil: &until}, Actor{Subject: "user-1"})
	if err != nil {
		t.Fatalf("Plan() error = %v", err)
	}
	if _, err := service.Confirm(context.Background(), plan.ID, plan.Confirmation, Actor{Subject: "user-1"}); err != nil {
		t.Fatalf("Confirm() error = %v", err)
	}
	if _, err := service.PlanRedaction(plan.Entry.ID, Actor{Subject: "user-1"}); !errors.Is(err, ErrRedactionForbidden) {
		t.Fatalf("unauthorized redaction error = %v, want ErrRedactionForbidden", err)
	}
	if _, err := service.PlanRedaction(plan.Entry.ID, Actor{Subject: "admin"}); err != nil {
		t.Fatalf("authorized redaction error = %v", err)
	}
}

func TestServiceRequiresExactActorAndConfirmation(t *testing.T) {
	store, err := state.OpenFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("OpenFileStore() error = %v", err)
	}
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	service, err := New(Config{Store: store, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	until := now.Add(time.Hour)
	plan, err := service.Plan(Input{Kind: domain.ContextKindDelayExplanation, Statement: "A dependency is pending.", Category: "dependency", ReportingFrom: &now, ReportingUntil: &until}, Actor{Subject: "user-1"})
	if err != nil {
		t.Fatalf("Plan() error = %v", err)
	}
	if _, err := service.Confirm(context.Background(), plan.ID, plan.Confirmation, Actor{Subject: "user-2"}); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("wrong actor error = %v, want ErrPlanNotFound", err)
	}
	if _, err := service.Confirm(context.Background(), plan.ID, "wrong confirmation", Actor{Subject: "user-1"}); !errors.Is(err, ErrConfirmationRequired) {
		t.Fatalf("wrong confirmation error = %v, want ErrConfirmationRequired", err)
	}
}
