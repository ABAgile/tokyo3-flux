package store

import (
	"context"
	"encoding/json"
	"errors"

	"abagile.com/tokyo3/flux/internal/integration"
	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/jackc/pgx/v5"
)

// EnqueueWebhook records a hint only for approved projects with registered links.
// Each workspace commits its receipt, dirty flags and audit atomically. If a
// later workspace fails, GitLab retries safely skip previously committed receipts.
func (s *Store) EnqueueWebhook(ctx context.Context, instance, delivery, digest string, h integration.Hint) error {
	if s.connector == nil || s.refreshInterval == 0 || instance != s.connector.Instance() {
		return p.ErrForbidden
	}
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT e.workspace_id FROM external_links e JOIN workspace_integrations i USING(workspace_id) WHERE e.project_id=$1 AND i.instance=$2 ORDER BY e.workspace_id LIMIT 1001`, h.Project, instance)
	if err != nil {
		return err
	}
	workspaces := []string{}
	for rows.Next() {
		var wid string
		if err = rows.Scan(&wid); err != nil {
			rows.Close()
			return err
		}
		workspaces = append(workspaces, wid)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	if len(workspaces) > 1000 {
		return errors.New("webhook workspace fanout exceeds limit")
	}
	for _, wid := range workspaces {
		if err = s.enqueueWorkspace(ctx, wid, instance, delivery, digest, h); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) enqueueWorkspace(ctx context.Context, wid, instance, delivery, digest string, h integration.Hint) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var locked string
	if err = tx.QueryRow(ctx, "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", wid).Scan(&locked); err != nil {
		return err
	}
	var approved bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM approved_gitlab_projects a JOIN workspace_integrations i USING(workspace_id) WHERE a.workspace_id=$1 AND a.project_id=$2 AND i.instance=$3)`, wid, h.Project, instance).Scan(&approved); err != nil {
		return err
	}
	if !approved {
		return tx.Commit(ctx)
	}
	var previous string
	err = tx.QueryRow(ctx, "SELECT digest FROM webhook_deliveries WHERE workspace_id=$1 AND instance=$2 AND delivery_id=$3", wid, instance, delivery).Scan(&previous)
	if err == nil {
		if previous != digest {
			return integration.ErrDeliveryConflict
		}
		return tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE external_links SET dirty=true WHERE workspace_id=$1 AND project_id=$2 AND
 (($3='mr' AND kind='mr' AND number=$4) OR ($3='pipeline' AND ((kind='pipeline' AND number=$4) OR (kind='mr' AND ($5=0 OR number=$5)))) OR ($3='push' AND kind='mr'))`, wid, h.Project, h.Kind, h.Number, h.MR)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return tx.Commit(ctx)
	}
	if _, err = tx.Exec(ctx, "INSERT INTO webhook_deliveries(workspace_id,instance,delivery_id,digest) VALUES($1,$2,$3,$4)", wid, instance, delivery, digest); err != nil {
		return err
	}
	detail, _ := json.Marshal(map[string]any{"project": h.Project, "kind": h.Kind, "number": h.Number, "links": tag.RowsAffected(), "delivery": delivery})
	if _, err = tx.Exec(ctx, `INSERT INTO audit_events(workspace_id,actor,action,request_id,after_state,outcome) VALUES($1,'system:gitlab-webhook','integration.webhook',$2,$3,'success')`, wid, p.NewID(), detail); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
