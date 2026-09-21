package store

import (
	"context"
	"errors"

	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/jackc/pgx/v5"
)

// Item resolves one work item by identity, active or archived. A shared card
// link opens the current card, so this is deliberately not a snapshot read and
// never walks archive pages: the card is found by primary key regardless of
// how much history the workspace holds. The workspace revision travels with it
// so a revision-checked write — restoring an archived card from the shared
// view — needs no separate board read.
func (s *Store) Item(ctx context.Context, wid, subject, itemID string) (p.ItemView, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return p.ItemView{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	r, err := role(ctx, tx, wid, subject)
	if err != nil {
		return p.ItemView{}, err
	}
	view := p.ItemView{Role: r}
	err = tx.QueryRow(ctx, "SELECT revision FROM workspaces WHERE id=$1", wid).Scan(&view.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return p.ItemView{}, p.ErrNotFound
	} else if err != nil {
		return p.ItemView{}, err
	}
	var v p.Item
	err = tx.QueryRow(ctx, "SELECT "+itemColumns+" FROM work_items i WHERE i.workspace_id=$1 AND i.id=$2", wid, itemID).
		Scan(&v.ID, &v.Title, &v.Description, &v.ColumnID, &v.ProjectID, &v.Assignee,
			&v.Rank, &v.Revision, &v.Archived, &v.ProjectIDs, &v.Labels, &v.Dependencies, &v.SprintIDs)
	if errors.Is(err, pgx.ErrNoRows) {
		return p.ItemView{}, p.ErrNotFound
	} else if err != nil {
		return p.ItemView{}, err
	}
	p.NormalizeItemProjects(&v)
	v.Attachments = []p.Attachment{}
	if err = tx.Commit(ctx); err != nil {
		return p.ItemView{}, err
	}
	items := []p.Item{v}
	if err = attachItemAttachments(ctx, s, wid, []string{v.ID}, items); err != nil {
		return p.ItemView{}, err
	}
	view.Item = items[0]
	return view, nil
}
