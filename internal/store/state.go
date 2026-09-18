package store

import (
	"context"
	"errors"

	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/jackc/pgx/v5"
)

// linkObservationDigest covers exactly the link fields the board reports, so a
// client can detect an observation update without reading the board.
const linkObservationDigest = `SELECT coalesce(md5(string_agg(
 e.id||'|'||coalesce(e.observation::text,'')||'|'||coalesce(e.last_success::text,'')||'|'||
 coalesce(e.last_attempt::text,'')||'|'||e.outcome||'|'||coalesce(e.next_refresh::text,'')||'|'||
 (e.dirty OR e.outcome='refreshing')::text||'|'||
 (SELECT coalesce(string_agg(i.item_id,',' ORDER BY i.item_id),'') FROM item_external_links i
   WHERE i.workspace_id=e.workspace_id AND i.link_id=e.id),
 '' ORDER BY e.id)),'') FROM external_links e WHERE e.workspace_id=$1`

// WorkspaceState answers the client's freshness poll with two indexed lookups
// instead of a full board load. It is read-only and permission-checked.
func (s *Store) WorkspaceState(ctx context.Context, wid, subject string) (p.WorkspaceState, error) {
	memberRole, err := role(ctx, s.pool, wid, subject)
	if err != nil {
		return p.WorkspaceState{}, err
	}
	var state p.WorkspaceState
	state.Role = memberRole
	err = s.pool.QueryRow(ctx, "SELECT revision FROM workspaces WHERE id=$1", wid).Scan(&state.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return p.WorkspaceState{}, p.ErrNotFound
	}
	if err != nil {
		return p.WorkspaceState{}, err
	}
	if err = s.pool.QueryRow(ctx, linkObservationDigest, wid).Scan(&state.Links); err != nil {
		return p.WorkspaceState{}, err
	}
	return state, nil
}
