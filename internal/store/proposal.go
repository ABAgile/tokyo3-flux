package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/jackc/pgx/v5"
)

func getProposal(ctx context.Context, tx pgx.Tx, wid, id string) (p.Proposal, error) {
	var v p.Proposal
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT id,sequence,state,imported_by,reviewed_by,review_reason,created_at,document,native_ids FROM proposals WHERE workspace_id=$1 AND id=$2`, wid, id).Scan(&v.ID, &v.Sequence, &v.State, &v.ImportedBy, &v.ReviewedBy, &v.ReviewReason, &v.CreatedAt, &raw, &v.NativeIDs)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, p.ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v.Document)
	return v, err
}
func previewProposal(ctx context.Context, tx pgx.Tx, b p.Board, v p.Proposal) (p.Board, p.ProposalPreview, error) {
	skipped := map[string]string{}
	for _, entry := range v.Document.Imports {
		var id string
		err := tx.QueryRow(ctx, "SELECT item_id FROM imported_items WHERE workspace_id=$1 AND source=$2", b.Workspace.ID, entry.Source).Scan(&id)
		if err == nil {
			skipped[entry.Source] = id
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return b, p.ProposalPreview{}, err
		}
	}
	after, preview, err := p.PreviewProposal(b, v, skipped)
	if err != nil {
		return b, preview, err
	}
	raw, err := json.Marshal(preview)
	if err != nil {
		return b, preview, err
	}
	sum := sha256.Sum256(raw)
	preview.Digest = hex.EncodeToString(sum[:])
	return after, preview, nil
}

// Review is a consistent, permission-checked preview. It never persists a draft.
func (s *Store) Review(ctx context.Context, wid, subject, id string) (p.ProposalPreview, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return p.ProposalPreview{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	b, err := load(ctx, tx, wid, subject)
	if err != nil {
		return p.ProposalPreview{}, err
	}
	v, err := getProposal(ctx, tx, wid, id)
	if err != nil {
		return p.ProposalPreview{}, err
	}
	if v.State == "accepted" {
		var raw []byte
		var preview p.ProposalPreview
		if err = tx.QueryRow(ctx, "SELECT accepted_preview FROM proposals WHERE workspace_id=$1 AND id=$2", wid, id).Scan(&raw); err != nil {
			return preview, err
		}
		if err = json.Unmarshal(raw, &preview); err != nil {
			return preview, err
		}
		return preview, tx.Commit(ctx)
	}
	if v.State != "draft" {
		return p.ProposalPreview{Proposal: v}, tx.Commit(ctx)
	}
	_, preview, err := previewProposal(ctx, tx, b, v)
	if errors.Is(err, p.ErrConflict) || errors.Is(err, p.ErrInvalid) || errors.Is(err, p.ErrNotFound) {
		return p.ProposalPreview{Proposal: v, Problem: "Planning or evidence changed. Refresh and import a revised document; acceptance is disabled."}, tx.Commit(ctx)
	}
	if err != nil {
		return preview, err
	}
	return preview, tx.Commit(ctx)
}

func (s *Store) Proposals(ctx context.Context, wid, subject string, before int64) ([]p.ProposalSummary, error) {
	if _, err := role(ctx, s.pool, wid, subject); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id,sequence,document->>'title',state,imported_by,(document->>'revision')::bigint FROM proposals WHERE workspace_id=$1 AND ($2::bigint=0 OR sequence<$2) ORDER BY sequence DESC LIMIT 20`, wid, before)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []p.ProposalSummary{}
	for rows.Next() {
		var v p.ProposalSummary
		if err = rows.Scan(&v.ID, &v.Sequence, &v.Title, &v.State, &v.ImportedBy, &v.Revision); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Called only after Change has locked the workspace, rechecked membership and
// checked the browser idempotency receipt. All review, import and audit writes
// share that transaction. Machine routes cannot call Change.
func (s *Store) changeProposal(ctx context.Context, tx pgx.Tx, b p.Board, subject, key, digest string, c p.Command) (int64, error) {
	if c.Revision != b.Workspace.Revision {
		return 0, p.ErrConflict
	}
	if len(c.Target) < 16 || len(c.Target) > 80 || strings.TrimSpace(c.Reason) == "" || len(c.Reason) > 4000 {
		return 0, p.ErrInvalid
	}
	var v p.Proposal
	var err error
	var preview p.ProposalPreview
	before, _ := json.Marshal(planningSnapshot(b))
	switch c.Kind {
	case "proposal.import":
		if c.Proposal == nil {
			return 0, p.ErrInvalid
		}
		var count int
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM proposals WHERE workspace_id=$1 AND state='draft'", b.Workspace.ID).Scan(&count); err != nil {
			return 0, err
		}
		if count >= 200 {
			return 0, p.ErrInvalid
		}
		v = p.Proposal{ID: c.Target, State: "draft", ImportedBy: subject, Document: *c.Proposal, NativeIDs: []string{}}
		for range v.Document.Imports {
			v.NativeIDs = append(v.NativeIDs, p.NewID())
		}
		if _, preview, err = previewProposal(ctx, tx, b, v); err != nil {
			return 0, err
		}
		raw, _ := json.Marshal(v.Document)
		inserted, err := tx.Exec(ctx, "INSERT INTO proposals(workspace_id,id,state,imported_by,document,native_ids) VALUES($1,$2,'draft',$3,$4,$5) ON CONFLICT(workspace_id,id) DO NOTHING", b.Workspace.ID, v.ID, subject, raw, v.NativeIDs)
		if err != nil {
			return 0, err
		}
		if inserted.RowsAffected() != 1 {
			return 0, p.ErrConflict
		}
	case "proposal.accept", "proposal.reject":
		if c.Proposal != nil {
			return 0, p.ErrInvalid
		}
		v, err = getProposal(ctx, tx, b.Workspace.ID, c.Target)
		if err != nil {
			return 0, err
		}
		if v.State != "draft" {
			return 0, p.ErrConflict
		}
		if c.Kind == "proposal.accept" {
			var after p.Board
			after, preview, err = previewProposal(ctx, tx, b, v)
			if err != nil {
				return 0, err
			}
			if c.Name == "" || c.Name != preview.Digest {
				return 0, p.ErrConflict
			}
			b = after
			if err = save(ctx, tx, b); err != nil {
				return 0, err
			}
			for i, entry := range v.Document.Imports {
				if _, ok := preview.Skipped[entry.Source]; ok {
					continue
				}
				if _, err = tx.Exec(ctx, "INSERT INTO imported_items(workspace_id,source,item_id,proposal_id) VALUES($1,$2,$3,$4)", b.Workspace.ID, entry.Source, v.NativeIDs[i], v.ID); err != nil {
					return 0, err
				}
			}
			// Every changed item (including reorder side effects) gets attributable history.
			for _, diff := range preview.Changes {
				if _, err = tx.Exec(ctx, "INSERT INTO work_item_events(workspace_id,revision,actor,action,target,reason) VALUES($1,$2,$3,'proposal.accept',$4,$5)", b.Workspace.ID, b.Workspace.Revision, subject, diff.ID, "Proposal "+v.ID+": "+c.Reason); err != nil {
					return 0, err
				}
			}
			v.State = "accepted"
		} else {
			v.State = "rejected"
		}
		v.ReviewedBy = subject
		v.ReviewReason = c.Reason
		preview.Proposal = v
		var accepted []byte
		if v.State == "accepted" {
			accepted, _ = json.Marshal(preview)
		}
		if _, err = tx.Exec(ctx, "UPDATE proposals SET state=$3,reviewed_by=$4,review_reason=$5,accepted_preview=$6 WHERE workspace_id=$1 AND id=$2", b.Workspace.ID, v.ID, v.State, subject, c.Reason, accepted); err != nil {
			return 0, err
		}
	default:
		return 0, p.ErrInvalid
	}
	after, _ := json.Marshal(map[string]any{"proposal_id": v.ID, "state": v.State, "reason": c.Reason, "preview": preview, "board": planningSnapshot(b)})
	if _, err = tx.Exec(ctx, "INSERT INTO audit_events(workspace_id,actor,action,request_id,before_state,after_state,outcome) VALUES($1,$2,$3,$4,$5,$6,'success')", b.Workspace.ID, subject, c.Kind, key, before, after); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO idempotency_keys VALUES($1,$2,$3,$4,$5)", b.Workspace.ID, subject, key, digest, b.Workspace.Revision); err != nil {
		return 0, err
	}
	return b.Workspace.Revision, tx.Commit(ctx)
}
