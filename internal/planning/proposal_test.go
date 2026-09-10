package planning

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestProposalRulesAndPreviewIsolation(t *testing.T) {
	b := testBoard()
	d := ProposalDocument{Version: 1, WorkspaceID: "w", Revision: 1, Title: "Plan", Rationale: "Inspect blockers", Provenance: "unverified", Evidence: []Evidence{{Kind: "item", ID: "a", Revision: 1}}, Operations: []Operation{{Kind: "item.move", Target: "a", ExpectedRevision: 1, Destination: "doing"}}}
	before, _ := json.Marshal(b)
	after, preview, err := PreviewProposal(b, Proposal{Document: d}, map[string]string{})
	if err != nil || after.Items[itemIndex(&after, "a")].ColumnID != "doing" || preview.WorkspaceChanges["revision"].After != int64(2) {
		t.Fatal(preview, err)
	}
	original, _ := json.Marshal(b)
	if string(before) != string(original) {
		t.Fatal("preview mutated original")
	}
	for _, kind := range []string{"sql", "shell", "integration.save", "member.name", "sprint.close", "item.create", "proposal.accept"} {
		bad := d
		bad.Operations = []Operation{{Kind: kind, Target: "a", ExpectedRevision: 1}}
		if err := bad.Validate(b); !errors.Is(err, ErrInvalid) {
			t.Fatal(kind, err)
		}
	}
	d.Operations = append(d.Operations, Operation{Kind: "item.move", Target: "b", ExpectedRevision: 1, Destination: "doing"})
	if _, _, err := PreviewProposal(b, Proposal{Document: d}, nil); !errors.Is(err, ErrInvalid) {
		t.Fatal("batch WIP", err)
	}
	d.Operations = d.Operations[:1]
	d.Operations[0].ExpectedRevision = 2
	if err := d.Validate(b); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
}
func TestProposalObservationEvidence(t *testing.T) {
	b := testBoard()
	at := time.Now().UTC()
	same := at.In(time.FixedZone("offset", 3600))
	b.Links = []ExternalLink{{ID: "link", LastSuccess: &at, Outcome: "ok"}}
	d := ProposalDocument{Version: 1, WorkspaceID: "w", Revision: 1, Title: "Plan", Rationale: "Review observation", Provenance: "unverified", Evidence: []Evidence{{Kind: "link", ID: "link", ObservedAt: &same, Outcome: "ok"}}, Operations: []Operation{{Kind: "item.rank", Target: "a", ExpectedRevision: 1}}}
	if err := d.Validate(b); err != nil {
		t.Fatal(err)
	}
	b.Links[0].RefreshPending = true
	if err := d.Validate(b); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	b.Links[0].RefreshPending = false
	b.Links[0].Outcome = "unavailable"
	if err := d.Validate(b); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	d.Evidence[0].ID = "other-workspace-link"
	if err := d.Validate(b); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}
func TestNativeReadPaginationAndSignals(t *testing.T) {
	b := testBoard()
	b.Items[0].Dependencies = []string{"b"}
	b.Items[0].SprintIDs = []string{"s1", "s2"}
	now := time.Now().UTC()
	old := now.Add(-6 * time.Minute)
	b.Links = []ExternalLink{{ID: "missing", LinkTarget: LinkTarget{Kind: "mr"}, Outcome: "unobserved"}, {ID: "failure", Items: []string{"a"}, LinkTarget: LinkTarget{Kind: "mr"}, Outcome: "ok", LastSuccess: &old, Observation: &Observation{MRState: "opened", Pipeline: &Pipeline{State: "failed", CurrentHead: true}}}, {ID: "nil-pipeline", LinkTarget: LinkTarget{Kind: "mr"}, Observation: &Observation{MRState: "opened"}}}
	page, err := ReadModel(b, "board", "", 0, 1, 0, now)
	if err != nil || page.Total != 2 || page.NextOffset == nil || *page.NextOffset != 1 {
		t.Fatal(page, err)
	}
	if !reflect.DeepEqual(page.Records[0].(ItemRead).Blockers, []string{"b"}) {
		t.Fatal(page)
	}
	if _, err := ReadModel(b, "board", "", 1, 1, 0, now); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	page, err = ReadModel(b, "board", "", 1, 1, 1, now)
	if err != nil || page.NextOffset != nil {
		t.Fatal(page, err)
	}
	page, err = ReadModel(b, "failures", "", 0, 20, 0, now)
	if err != nil || page.Total != 1 || !page.Records[0].(LinkRead).Stale {
		t.Fatal(page, err)
	}
	for _, view := range []string{"triage", "sprints", "review", "links", "catalog", "imports"} {
		if _, err := ReadModel(b, view, "", 0, 20, 0, now); err != nil {
			t.Fatal(view, err)
		}
	}
	if _, err := ReadModel(b, "item", "foreign", 0, 20, 0, now); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if _, err := ReadModel(b, "board", "", 0, 51, 0, now); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}
func TestImportRequiresExplicitUnambiguousMappings(t *testing.T) {
	var snapshot Snapshot
	if err := json.Unmarshal([]byte(`{"sprint":{"work_items":[{"id":"#7","project_id":42,"title":"Imported"}]}}`), &snapshot); err != nil {
		t.Fatal(err)
	}
	report := CompileImport(snapshot, ImportMapping{}, "w", 1)
	if report.Document != nil || len(report.Unresolved) != 1 {
		t.Fatal(report)
	}
	mapping := ImportMapping{Instance: "https://gitlab.example", Records: []RecordMapping{{SnapshotID: "#7", GitLabProjectID: 42, IssueIID: 7, Item: Item{ColumnID: "ready", Priority: "normal"}}}}
	report = CompileImport(snapshot, mapping, "w", 1)
	if report.Document == nil || report.Matched != 1 {
		t.Fatal(report)
	}
	mapping.Records[0].GitLabProjectID = 43
	if r := CompileImport(snapshot, mapping, "w", 1); r.Document != nil {
		t.Fatal(r)
	}
	mapping.Records[0].Skip = true
	mapping.Records[0].Reason = "Cannot resolve project"
	report = CompileImport(snapshot, mapping, "w", 1)
	if len(report.Skipped) != 1 || report.Document != nil {
		t.Fatal(report)
	}
	for _, source := range []string{"http://gitlab.example/projects/42/issues/7/", "https://GITLAB.example/projects/42/issues/7/", "https://gitlab.example:443/projects/42/issues/7/", "https://gitlab.example/a/../projects/42/issues/7/", "https://user:secret@gitlab.example/projects/42/issues/7/", "https://gitlab.example/projects/42/issues/07/", "https://gitlab.example/projects/42/issues/7/?token=x"} {
		if ValidImportSource(source) {
			t.Fatal(source)
		}
	}
}
