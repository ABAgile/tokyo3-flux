package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/jackc/pgx/v5"
)

const auditBoardState = `((before_state IS NOT NULL AND (before_state ? 'columns' OR (before_state->'board') ? 'columns')) OR (after_state IS NOT NULL AND (after_state ? 'columns' OR (after_state->'board') ? 'columns')))`

// Burndown returns a daily, read-only view derived from native audit snapshots.
// It never treats GitLab observations as work-item state.
func (s *Store) Burndown(ctx context.Context, wid, subject, sprintID, project, assignee string) (p.Burndown, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return p.Burndown{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	b, err := load(ctx, tx, wid, subject)
	if err != nil {
		return p.Burndown{}, err
	}
	selected := -1
	for i, sprint := range b.Sprints {
		if sprint.ID == sprintID {
			selected = i
			break
		}
	}
	if selected < 0 || b.Sprints[selected].State == "archived" {
		return p.Burndown{}, p.ErrNotFound
	}
	start, startErr := time.ParseInLocation("2006-01-02", b.Sprints[selected].Start, time.UTC)
	end, endErr := time.ParseInLocation("2006-01-02", b.Sprints[selected].End, time.UTC)
	if startErr != nil || endErr != nil || end.Before(start) || int(end.Sub(start)/(24*time.Hour))+1 > p.MaxBurndownDays {
		return p.Burndown{}, fmt.Errorf("%w: sprint dates must span at most %d days", p.ErrInvalid, p.MaxBurndownDays)
	}
	endExclusive := end.AddDate(0, 0, 1)
	snapshots := []p.BurndownSnapshot{}
	var at time.Time
	var before, after []byte
	err = tx.QueryRow(ctx, `SELECT at,before_state,after_state FROM audit_events
 WHERE workspace_id=$1 AND outcome='success' AND at<$2 AND `+auditBoardState+`
 ORDER BY at DESC,id DESC LIMIT 1`, wid, start).Scan(&at, &before, &after)
	if err == nil {
		if snapshot := decodeBurndownSnapshot(at, before, after); snapshot.Before != nil || snapshot.After != nil {
			snapshots = append(snapshots, snapshot)
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return p.Burndown{}, err
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT ON ((at AT TIME ZONE 'UTC')::date)
 at,before_state,after_state FROM audit_events
 WHERE workspace_id=$1 AND outcome='success' AND at>=$2 AND at<$3 AND `+auditBoardState+`
 ORDER BY (at AT TIME ZONE 'UTC')::date,at DESC,id DESC`, wid, start, endExclusive)
	if err != nil {
		return p.Burndown{}, err
	}
	for rows.Next() {
		var snapshotAt time.Time
		var snapshotBefore, snapshotAfter []byte
		if err = rows.Scan(&snapshotAt, &snapshotBefore, &snapshotAfter); err != nil {
			rows.Close()
			return p.Burndown{}, err
		}
		snapshot := decodeBurndownSnapshot(snapshotAt, snapshotBefore, snapshotAfter)
		if snapshot.Before != nil || snapshot.After != nil {
			snapshots = append(snapshots, snapshot)
		}
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return p.Burndown{}, err
	}
	rows.Close()
	result, err := p.BuildBurndown(b, sprintID, project, assignee, snapshots, time.Now().UTC())
	if err != nil {
		return p.Burndown{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return p.Burndown{}, err
	}
	return result, nil
}

func decodeBurndownSnapshot(at time.Time, before, after []byte) p.BurndownSnapshot {
	return p.BurndownSnapshot{At: at, Before: decodeBurndownBoard(before), After: decodeBurndownBoard(after)}
}

func decodeBurndownBoard(raw []byte) *p.Board {
	if len(raw) == 0 {
		return nil
	}
	var board p.Board
	if json.Unmarshal(raw, &board) == nil && validBurndownBoard(board) {
		return &board
	}
	var envelope struct {
		Board json.RawMessage `json:"board"`
	}
	var wrapped p.Board
	if json.Unmarshal(raw, &envelope) != nil || json.Unmarshal(envelope.Board, &wrapped) != nil || !validBurndownBoard(wrapped) {
		return nil
	}
	return &wrapped
}

func validBurndownBoard(board p.Board) bool {
	return board.Workspace.ID != "" && board.Columns != nil && board.Items != nil && board.Sprints != nil
}
