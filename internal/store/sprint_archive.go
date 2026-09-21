package store

import (
	"context"

	p "abagile.com/tokyo3/flux/internal/planning"
)

// ArchivedSprints returns immutable closure summaries independently of the
// working board. The page is ordered newest-first and never exposes archived
// sprints as writable board state.
func (s *Store) ArchivedSprints(ctx context.Context, wid, subject string, offset, limit int) (p.SprintHistoryPage, error) {
	out := p.SprintHistoryPage{Records: []p.SprintHistory{}}
	if _, err := role(ctx, s.pool, wid, subject); err != nil {
		return out, err
	}
	if offset < 0 || limit <= 0 || limit > p.SprintArchivePageLimit {
		return out, p.ErrInvalid
	}
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM sprints WHERE workspace_id=$1 AND state='archived'", wid).Scan(&out.Total); err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `SELECT s.id,s.name,s.goal,to_char(s.start_date,'YYYY-MM-DD'),to_char(s.end_date,'YYYY-MM-DD'),s.state,s.revision,
		c.closed_at,c.scope_count,c.completed_count,c.carry_over_count,
		ARRAY(SELECT scope.item_id FROM closed_sprint_scope scope WHERE scope.workspace_id=s.workspace_id AND scope.sprint_id=s.id ORDER BY scope.item_id)
		FROM sprints s JOIN sprint_closures c ON c.workspace_id=s.workspace_id AND c.sprint_id=s.id
		WHERE s.workspace_id=$1 AND s.state='archived'
		ORDER BY c.closed_at DESC,s.id LIMIT $2 OFFSET $3`, wid, limit, offset)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var history p.SprintHistory
		if err := rows.Scan(&history.Sprint.ID, &history.Sprint.Name, &history.Sprint.Goal, &history.Sprint.Start, &history.Sprint.End, &history.Sprint.State, &history.Sprint.Revision,
			&history.Closure.ClosedAt, &history.Closure.ScopeCount, &history.Closure.CompletedCount, &history.Closure.CarryOverCount, &history.Closure.Scope); err != nil {
			return out, err
		}
		history.Closure.SprintID = history.Sprint.ID
		out.Records = append(out.Records, history)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	end := offset + len(out.Records)
	if end < out.Total {
		out.NextOffset = &end
	}
	return out, nil
}
