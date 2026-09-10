package store

import (
	"context"
	"errors"
	"sync"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

func proposalFixture(t *testing.T, s *Store, b *p.Board) p.ProposalDocument {
	t.Helper()
	if len(b.Items) == 0 {
		it := newItem(*b, "Original")
		apply(t, s, b, p.Command{Kind: "item.create", Item: &it})
	}
	it := b.Items[0]
	it.Title = "Approved title"
	return p.ProposalDocument{Version: 1, WorkspaceID: b.Workspace.ID, Revision: b.Workspace.Revision, Title: "Triage", Rationale: "Human-reviewed acceptance criteria", Provenance: "agent claim, not verified", Evidence: []p.Evidence{{Kind: "item", ID: it.ID, Revision: it.Revision}}, Operations: []p.Operation{{Kind: "item.update", Target: it.ID, ExpectedRevision: it.Revision, Item: &it}}}
}
func persistProposal(t *testing.T, s *Store, b *p.Board, d p.ProposalDocument) string {
	t.Helper()
	id := p.NewID()
	apply(t, s, b, p.Command{Kind: "proposal.import", Target: id, Proposal: &d, Reason: "Inspect draft"})
	return id
}
func acceptCommand(t *testing.T, s *Store, b p.Board, id string) p.Command {
	t.Helper()
	preview, err := s.Review(context.Background(), b.Workspace.ID, "alice", id)
	if err != nil || preview.Digest == "" {
		t.Fatal(preview, err)
	}
	return p.Command{Kind: "proposal.accept", Revision: b.Workspace.Revision, Target: id, Name: preview.Digest, Reason: "Reviewed exact diff"}
}
func TestProposalAtomicIdempotentAcceptance(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	d := proposalFixture(t, s, &b)
	rev := b.Workspace.Revision
	id := persistProposal(t, s, &b, d)
	ctx := context.Background()
	if _, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), p.Command{Kind: "proposal.import", Revision: rev, Target: id, Proposal: &d, Reason: "Duplicate draft ID"}); !errors.Is(err, p.ErrConflict) {
		t.Fatal(err)
	}
	if b.Workspace.Revision != rev || b.Items[0].Title != "Original" {
		t.Fatal("draft changed planning")
	}
	preview, err := s.Review(ctx, b.Workspace.ID, "alice", id)
	if err != nil || len(preview.Changes) != 1 || preview.Changes[0].Fields["title"].Before != "Original" {
		t.Fatal(preview, err)
	}
	c := acceptCommand(t, s, b, id)
	key := p.NewID()
	got, err := s.Change(ctx, b.Workspace.ID, "alice", key, c)
	if err != nil || got != rev+1 {
		t.Fatal(got, err)
	}
	if retry, err := s.Change(ctx, b.Workspace.ID, "alice", key, c); err != nil || retry != got {
		t.Fatal(retry, err)
	}
	b = getBoard(t, s, b.Workspace.ID)
	if b.Items[0].Title != "Approved title" {
		t.Fatal(b)
	}
	c.Revision = b.Workspace.Revision
	if _, err = s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), c); !errors.Is(err, p.ErrConflict) {
		t.Fatal("second acceptance", err)
	}
	it := b.Items[0]
	it.Title = "Later native edit"
	apply(t, s, &b, p.Command{Kind: "item.update", Target: it.ID, Item: &it})
	historical, err := s.Review(ctx, b.Workspace.ID, "alice", id)
	if err != nil || historical.Proposal.ReviewedBy != "alice" || historical.Changes[0].Fields["title"].After != "Approved title" {
		t.Fatal(historical, err)
	}
	rows, err := s.Proposals(ctx, b.Workspace.ID, "alice", 0)
	if err != nil || len(rows) != 1 {
		t.Fatal(rows, err)
	}
	rows, err = s.Proposals(ctx, b.Workspace.ID, "alice", rows[0].Sequence)
	if err != nil || len(rows) != 0 {
		t.Fatal(rows, err)
	}
	other := bootstrap(t, s)
	if _, err = s.Review(ctx, other.Workspace.ID, "alice", id); !errors.Is(err, p.ErrNotFound) {
		t.Fatal(err)
	}
	if _, err = s.Review(ctx, b.Workspace.ID, "intruder", id); !errors.Is(err, p.ErrForbidden) {
		t.Fatal(err)
	}
}
func TestProposalStalePermissionsAndPreviewBinding(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	d := proposalFixture(t, s, &b)
	id := persistProposal(t, s, &b, d)
	c := acceptCommand(t, s, b, id)
	ctx := context.Background()
	bad := c
	bad.Name = "wrong"
	if _, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), bad); !errors.Is(err, p.ErrConflict) {
		t.Fatal(err)
	}
	if err := s.SetMember(ctx, b.Workspace.ID, "reader", "viewer"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Change(ctx, b.Workspace.ID, "reader", p.NewID(), c); !errors.Is(err, p.ErrForbidden) {
		t.Fatal(err)
	}
	it := b.Items[0]
	it.Title = "Concurrent edit"
	apply(t, s, &b, p.Command{Kind: "item.update", Target: it.ID, Item: &it})
	c.Revision = b.Workspace.Revision
	if _, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), c); !errors.Is(err, p.ErrConflict) {
		t.Fatal(err)
	}
	preview, err := s.Review(ctx, b.Workspace.ID, "alice", id)
	if err != nil || preview.Problem == "" || preview.Digest != "" || preview.Proposal.Document.Title != "Triage" {
		t.Fatal(preview, err)
	}
	apply(t, s, &b, p.Command{Kind: "proposal.reject", Target: id, Reason: "Stale proposal rejected"})
}
func TestProposalAuditFailureAndConcurrentAcceptance(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	d := proposalFixture(t, s, &b)
	id := persistProposal(t, s, &b, d)
	c := acceptCommand(t, s, b, id)
	ctx := context.Background()
	execSQL(t, s, `CREATE FUNCTION reject_proposal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER reject_proposal_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_proposal_audit()`)
	if _, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), c); err == nil {
		t.Fatal("audit failure did not abort")
	}
	b = getBoard(t, s, b.Workspace.ID)
	if b.Items[0].Title != "Original" {
		t.Fatal("partial planning write")
	}
	preview, err := s.Review(ctx, b.Workspace.ID, "alice", id)
	if err != nil || preview.Proposal.State != "draft" {
		t.Fatal(preview, err)
	}
	execSQL(t, s, "DROP TRIGGER reject_proposal_audit ON audit_events")
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() { _, err := s.Change(ctx, b.Workspace.ID, "alice", p.NewID(), c); results <- err })
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, p.ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal(successes, conflicts)
	}
}
func TestImportStableIdentityAndNoOverwrite(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	ctx := context.Background()
	it := newItem(b, "Imported")
	d := p.ProposalDocument{Version: 1, WorkspaceID: b.Workspace.ID, Revision: b.Workspace.Revision, Title: "Mapped import", Rationale: "Explicit human mappings", Provenance: "snapshot, unverified", Imports: []p.ImportItem{{Source: "https://gitlab.example/projects/42/issues/7/", Item: it}}}
	id := persistProposal(t, s, &b, d)
	c := acceptCommand(t, s, b, id)
	apply(t, s, &b, c)
	if len(b.Imported) != 1 || len(b.Items) != 1 || b.Imported[0].ItemID != b.Items[0].ID || b.Items[0].ID == "7" {
		t.Fatal(b)
	}
	native := b.Items[0]
	native.Title = "Native edits win"
	apply(t, s, &b, p.Command{Kind: "item.update", Target: native.ID, Item: &native})
	d.Revision = b.Workspace.Revision
	id2 := persistProposal(t, s, &b, d)
	preview, err := s.Review(ctx, b.Workspace.ID, "alice", id2)
	if err != nil || preview.Created != 0 || len(preview.Skipped) != 1 || len(preview.Changes) != 0 {
		t.Fatal(preview, err)
	}
	before := b.Workspace.Revision
	apply(t, s, &b, acceptCommand(t, s, b, id2))
	if len(b.Items) != 1 || b.Items[0].ID != native.ID || b.Items[0].Title != "Native edits win" || b.Workspace.Revision != before {
		t.Fatal(b)
	}
}
func TestProposalBatchValidationRollsBack(t *testing.T) {
	s := testStore(t)
	b := bootstrap(t, s)
	d := proposalFixture(t, s, &b)
	it := newItem(b, "Second")
	apply(t, s, &b, p.Command{Kind: "item.create", Item: &it})
	d.Revision = b.Workspace.Revision
	it = b.Items[1]
	it.ColumnID = "cross-workspace-column"
	d.Operations = append(d.Operations, p.Operation{Kind: "item.update", Target: it.ID, ExpectedRevision: it.Revision, Item: &it})
	if _, err := s.Change(context.Background(), b.Workspace.ID, "alice", p.NewID(), p.Command{Kind: "proposal.import", Revision: b.Workspace.Revision, Target: p.NewID(), Reason: "Bad batch", Proposal: &d}); !errors.Is(err, p.ErrInvalid) {
		t.Fatal(err)
	}
	rows, _ := s.Proposals(context.Background(), b.Workspace.ID, "alice", 0)
	if len(rows) != 0 || getBoard(t, s, b.Workspace.ID).Items[0].Title != "Original" {
		t.Fatal("partial draft/batch")
	}
}
