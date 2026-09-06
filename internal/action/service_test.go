package action

import (
	"context"
	"errors"
	"testing"
	"time"

	"abagile.com/tokyo3/flux/internal/domain"
	"abagile.com/tokyo3/flux/internal/gitlab"
	"abagile.com/tokyo3/flux/internal/state"
)

type fakeIssueClient struct {
	issues       []gitlab.Issue
	readCalls    int
	readProject  int
	readIssueIID int
	writeCalls   int
	writeLabel   string
	writeErr     error
	labels       []string
	labelErr     error
	labelCalls   int
}

func (f *fakeIssueClient) GetIssue(_ context.Context, projectID, issueIID int) (gitlab.Issue, error) {
	f.readCalls++
	f.readProject = projectID
	f.readIssueIID = issueIID
	if len(f.issues) == 0 {
		return gitlab.Issue{}, errors.New("no fake issue")
	}
	issue := f.issues[0]
	if len(f.issues) > 1 {
		f.issues = f.issues[1:]
	}
	return issue, nil
}

func (f *fakeIssueClient) AddIssueLabel(_ context.Context, projectID, issueIID int, label string) error {
	f.writeCalls++
	f.readProject = projectID
	f.readIssueIID = issueIID
	f.writeLabel = label
	return f.writeErr
}

func (f *fakeIssueClient) ListProjectLabels(_ context.Context, _ int) ([]string, error) {
	f.labelCalls++
	return append([]string(nil), f.labels...), f.labelErr
}

type fakeAudit struct {
	events    []state.AuditEvent
	err       error
	failAfter int
}

func (f *fakeAudit) RecordAudit(event state.AuditEvent) error {
	if f.err != nil && (f.failAfter == 0 || len(f.events) >= f.failAfter) {
		return f.err
	}
	f.events = append(f.events, event)
	return nil
}

func testService(t *testing.T, client *fakeIssueClient, audit *fakeAudit, trigger *int, now time.Time) *Service {
	t.Helper()
	store := state.NewMemoryStore()
	if err := store.Put(domain.Snapshot{
		GeneratedAt: now,
		Sprint: domain.Sprint{
			Name: "Flow 01",
			WorkItems: []domain.WorkItem{{
				ID:          "team/platform/service#12",
				ProjectID:   42,
				ProjectPath: "team/platform/service",
				Title:       "Add the label",
				State:       domain.IssueOpen,
			}},
		},
	}); err != nil {
		t.Fatalf("store.Put() error = %v", err)
	}
	if client.labels == nil {
		client.labels = []string{"reviewed", "status::blocked", "triage"}
	}
	service, err := New(Config{
		Snapshot: store,
		Reader:   client,
		Labels:   client,
		Writer:   client,
		Audit:    audit,
		Trigger: func() {
			(*trigger)++
		},
		Now: func() time.Time {
			return now
		},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return service
}

func testIssue(updatedAt time.Time) gitlab.Issue {
	return gitlab.Issue{
		IID:       12,
		ProjectID: 42,
		Title:     "Add the label",
		State:     domain.IssueOpen,
		UpdatedAt: updatedAt,
	}
}

func TestPlanAndConfirmAddLabel(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	client := &fakeIssueClient{issues: []gitlab.Issue{testIssue(now)}}
	audit := &fakeAudit{}
	triggered := 0
	service := testService(t, client, audit, &triggered, now)
	actor := Actor{Subject: "user-1", Name: "Alex"}

	plan, err := service.PlanAddLabel(context.Background(), "team/platform/service#12", "status::blocked", actor)
	if err != nil {
		t.Fatalf("PlanAddLabel() error = %v", err)
	}
	if plan.Action != AddLabelAction || plan.ItemID != "team/platform/service#12" || plan.ProjectID != 42 || plan.IssueIID != 12 || plan.Label != "status::blocked" || plan.Confirmation == "" {
		t.Fatalf("plan = %+v, want exact label plan", plan)
	}
	if !plan.ExpiresAt.After(plan.CreatedAt) || len(audit.events) != 1 || audit.events[0].Outcome != "planned" {
		t.Fatalf("plan expiry/audit = %+v / %+v", plan, audit.events)
	}

	result, err := service.ConfirmAddLabel(context.Background(), plan.ID, plan.Confirmation, actor)
	if err != nil {
		t.Fatalf("ConfirmAddLabel() error = %v", err)
	}
	if result.PlanID != plan.ID || result.Label != plan.Label || result.ProjectPath != plan.ProjectPath || result.AppliedAt.IsZero() {
		t.Fatalf("result = %+v, want applied result", result)
	}
	if client.readCalls != 2 || client.readProject != 42 || client.readIssueIID != 12 || client.writeCalls != 1 || client.writeLabel != "status::blocked" || triggered != 1 {
		t.Fatalf("client calls = reads %d, target %d/%d, writes %d label %q, triggers %d", client.readCalls, client.readProject, client.readIssueIID, client.writeCalls, client.writeLabel, triggered)
	}
	if len(audit.events) != 3 || audit.events[0].ProjectID != 42 || audit.events[1].Outcome != "approved" || audit.events[2].Outcome != "applied" {
		t.Fatalf("audit events = %+v, want planned/approved/applied", audit.events)
	}
	if _, err := service.ConfirmAddLabel(context.Background(), plan.ID, plan.Confirmation, actor); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("second confirmation error = %v, want ErrPlanNotFound", err)
	}
}

func TestConfirmAddLabelRejectsChangedIssue(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	client := &fakeIssueClient{issues: []gitlab.Issue{testIssue(now), testIssue(now.Add(time.Minute))}}
	audit := &fakeAudit{}
	triggered := 0
	service := testService(t, client, audit, &triggered, now)
	actor := Actor{Subject: "user-1"}

	plan, err := service.PlanAddLabel(context.Background(), "team/platform/service#12", "reviewed", actor)
	if err != nil {
		t.Fatalf("PlanAddLabel() error = %v", err)
	}
	if _, err := service.ConfirmAddLabel(context.Background(), plan.ID, plan.Confirmation, actor); !errors.Is(err, ErrActionConflict) {
		t.Fatalf("ConfirmAddLabel() error = %v, want ErrActionConflict", err)
	}
	if client.writeCalls != 0 || triggered != 0 {
		t.Fatalf("changed issue caused write/trigger: writes %d, triggers %d", client.writeCalls, triggered)
	}
	if len(audit.events) != 2 || audit.events[1].Outcome != "failed" {
		t.Fatalf("audit events = %+v, want planned/failed", audit.events)
	}
}

func TestConfirmAddLabelRequiresExactActorConfirmationAndWriter(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	client := &fakeIssueClient{issues: []gitlab.Issue{testIssue(now), testIssue(now)}}
	audit := &fakeAudit{}
	triggered := 0
	service := testService(t, client, audit, &triggered, now)
	actor := Actor{Subject: "user-1"}

	plan, err := service.PlanAddLabel(context.Background(), "team/platform/service#12", "reviewed", actor)
	if err != nil {
		t.Fatalf("PlanAddLabel() error = %v", err)
	}
	if _, err := service.ConfirmAddLabel(context.Background(), plan.ID, "approve", actor); !errors.Is(err, ErrConfirmationRequired) {
		t.Fatalf("wrong confirmation error = %v, want ErrConfirmationRequired", err)
	}
	if client.writeCalls != 0 {
		t.Fatalf("wrong confirmation caused %d writes", client.writeCalls)
	}
	if _, err := service.ConfirmAddLabel(context.Background(), plan.ID, plan.Confirmation, Actor{Subject: "user-2"}); !errors.Is(err, ErrPlanNotFound) {
		t.Fatalf("wrong actor error = %v, want ErrPlanNotFound", err)
	}
}

func TestConfirmAddLabelRejectsExpiredPlan(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	client := &fakeIssueClient{issues: []gitlab.Issue{testIssue(now)}}
	audit := &fakeAudit{}
	service := testService(t, client, audit, new(int), now)
	actor := Actor{Subject: "user-1"}

	plan, err := service.PlanAddLabel(context.Background(), "team/platform/service#12", "reviewed", actor)
	if err != nil {
		t.Fatalf("PlanAddLabel() error = %v", err)
	}
	service.now = func() time.Time { return now.Add(11 * time.Minute) }
	if _, err := service.ConfirmAddLabel(context.Background(), plan.ID, plan.Confirmation, actor); !errors.Is(err, ErrPlanExpired) {
		t.Fatalf("ConfirmAddLabel() error = %v, want ErrPlanExpired", err)
	}
	if client.readCalls != 1 || client.writeCalls != 0 || len(audit.events) != 2 || audit.events[1].Outcome != "expired" {
		t.Fatalf("expired plan caused reads %d, writes %d, audit %+v", client.readCalls, client.writeCalls, audit.events)
	}
}

func TestAvailableLabelsExcludesLabelsAlreadyOnIssue(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	issue := testIssue(now)
	issue.Labels = []string{"existing", "Status::Blocked"}
	client := &fakeIssueClient{
		issues: []gitlab.Issue{issue},
		labels: []string{"existing", "status::blocked", "reviewed", "reviewed", ""},
	}
	service := testService(t, client, &fakeAudit{}, new(int), now)

	labels, err := service.AvailableLabels(context.Background(), "team/platform/service#12")
	if err != nil {
		t.Fatalf("AvailableLabels() error = %v", err)
	}
	if got, want := len(labels), 1; got != want || labels[0] != "reviewed" {
		t.Fatalf("available labels = %v, want [%q]", labels, "reviewed")
	}
	if client.labelCalls != 1 {
		t.Fatalf("label calls = %d, want one", client.labelCalls)
	}
}

func TestPlanAddLabelRejectsUndefinedLabel(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	client := &fakeIssueClient{issues: []gitlab.Issue{testIssue(now)}, labels: []string{"reviewed"}}
	audit := &fakeAudit{}
	service := testService(t, client, audit, new(int), now)

	if _, err := service.PlanAddLabel(context.Background(), "team/platform/service#12", "not-defined", Actor{Subject: "user-1"}); !errors.Is(err, ErrLabelUnavailable) {
		t.Fatalf("PlanAddLabel() error = %v, want ErrLabelUnavailable", err)
	}
	if client.writeCalls != 0 || len(audit.events) != 0 || client.labelCalls != 1 {
		t.Fatalf("undefined label caused writes %d, audit events %d, label calls %d", client.writeCalls, len(audit.events), client.labelCalls)
	}
}

func TestConfirmAddLabelRejectsLabelRemovedAfterPlanning(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	client := &fakeIssueClient{issues: []gitlab.Issue{testIssue(now), testIssue(now)}, labels: []string{"reviewed"}}
	audit := &fakeAudit{}
	service := testService(t, client, audit, new(int), now)
	actor := Actor{Subject: "user-1"}

	plan, err := service.PlanAddLabel(context.Background(), "team/platform/service#12", "reviewed", actor)
	if err != nil {
		t.Fatalf("PlanAddLabel() error = %v", err)
	}
	client.labels = []string{"triage"}
	if _, err := service.ConfirmAddLabel(context.Background(), plan.ID, plan.Confirmation, actor); !errors.Is(err, ErrLabelUnavailable) {
		t.Fatalf("ConfirmAddLabel() error = %v, want ErrLabelUnavailable", err)
	}
	if client.writeCalls != 0 || len(audit.events) != 2 || audit.events[1].Outcome != "failed" {
		t.Fatalf("removed label caused writes %d, audit events %+v", client.writeCalls, audit.events)
	}
}

func TestConfirmAddLabelRequiresMutationCredential(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	client := &fakeIssueClient{issues: []gitlab.Issue{testIssue(now), testIssue(now)}}
	audit := &fakeAudit{}
	triggered := 0
	service := testService(t, client, audit, &triggered, now)
	service.writer = nil
	actor := Actor{Subject: "user-1"}

	plan, err := service.PlanAddLabel(context.Background(), "team/platform/service#12", "reviewed", actor)
	if err != nil {
		t.Fatalf("PlanAddLabel() error = %v", err)
	}
	if _, err := service.ConfirmAddLabel(context.Background(), plan.ID, plan.Confirmation, actor); !errors.Is(err, ErrMutationUnavailable) {
		t.Fatalf("ConfirmAddLabel() error = %v, want ErrMutationUnavailable", err)
	}
	if client.writeCalls != 0 || triggered != 0 || len(audit.events) != 2 || audit.events[1].Outcome != "failed" {
		t.Fatalf("missing writer caused writes %d, triggers %d, audit %+v", client.writeCalls, triggered, audit.events)
	}
}

func TestConfirmAddLabelAuditsBeforeWriting(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	client := &fakeIssueClient{issues: []gitlab.Issue{testIssue(now), testIssue(now)}}
	audit := &fakeAudit{err: errors.New("audit unavailable"), failAfter: 1}
	service := testService(t, client, audit, new(int), now)
	actor := Actor{Subject: "user-1"}

	plan, err := service.PlanAddLabel(context.Background(), "team/platform/service#12", "reviewed", actor)
	if err != nil {
		t.Fatalf("PlanAddLabel() error = %v", err)
	}
	if _, err := service.ConfirmAddLabel(context.Background(), plan.ID, plan.Confirmation, actor); !errors.Is(err, ErrAuditUnavailable) {
		t.Fatalf("ConfirmAddLabel() error = %v, want ErrAuditUnavailable", err)
	}
	if client.writeCalls != 0 {
		t.Fatalf("audit failure caused %d writes", client.writeCalls)
	}
}

func TestPlanAddLabelRejectsUnqualifiedOrInvalidTarget(t *testing.T) {
	now := time.Date(2026, time.February, 2, 12, 0, 0, 0, time.UTC)
	client := &fakeIssueClient{issues: []gitlab.Issue{testIssue(now)}}
	audit := &fakeAudit{}
	triggered := 0
	service := testService(t, client, audit, &triggered, now)
	actor := Actor{Subject: "user-1"}

	for _, test := range []struct {
		name   string
		itemID string
		label  string
		want   error
	}{
		{name: "unknown issue", itemID: "team/platform/service#99", label: "reviewed", want: ErrTargetNotFound},
		{name: "invalid label", itemID: "team/platform/service#12", label: "bad,label", want: ErrInvalidRequest},
		{name: "empty label", itemID: "team/platform/service#12", label: " ", want: ErrInvalidRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := service.PlanAddLabel(context.Background(), test.itemID, test.label, actor); !errors.Is(err, test.want) {
				t.Fatalf("PlanAddLabel() error = %v, want %v", err, test.want)
			}
		})
	}
	if client.readCalls != 0 {
		t.Fatalf("invalid plans performed %d GitLab reads", client.readCalls)
	}
}
