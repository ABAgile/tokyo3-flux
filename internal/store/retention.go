package store

import (
	"context"
	"fmt"

	p "abagile.com/tokyo3/flux/internal/planning"
)

const (
	// DefaultAuditRetentionDays bounds audit_events growth. Every planning
	// change stores a before/after board snapshot, so the table grows with
	// activity and never shrinks on its own. The default stays comfortably
	// above MaxBurndownDays so a full-length sprint can always replay its own
	// history from audit snapshots.
	DefaultAuditRetentionDays = p.MaxBurndownDays + 34
	// MinAuditRetentionDays refuses a window that would silently break
	// burn-down reads for long sprints.
	MinAuditRetentionDays = p.MaxBurndownDays
	// auditPruneBatch keeps each statement short so pruning never holds locks
	// that matter to a serving workspace.
	auditPruneBatch = 1000
)

// PruneAudit deletes audit events older than days and reports how many rows it
// removed. It is an explicit operator command run with admin credentials: the
// runtime role has no DELETE on audit_events, so serving can never erase its
// own evidence. Deletion is batched, so interrupting it only stops progress.
func (s *Store) PruneAudit(ctx context.Context, days int) (int64, error) {
	if days < MinAuditRetentionDays {
		return 0, fmt.Errorf("%w: audit retention must keep at least %d days so burn-down history survives", p.ErrInvalid, MinAuditRetentionDays)
	}
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		tag, err := s.pool.Exec(ctx, `DELETE FROM audit_events WHERE id IN (
 SELECT id FROM audit_events WHERE at<now()-make_interval(days => $1) ORDER BY id LIMIT $2)`,
			days, auditPruneBatch)
		if err != nil {
			return total, err
		}
		total += tag.RowsAffected()
		if tag.RowsAffected() < auditPruneBatch {
			return total, nil
		}
	}
}
