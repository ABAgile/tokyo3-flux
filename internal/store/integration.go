package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"slices"
	"time"

	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/jackc/pgx/v5"
)

func loadIntegration(ctx context.Context, tx pgx.Tx, b *p.Board) error {
	b.Integration.Projects = []int64{}
	b.Links = []p.ExternalLink{}
	err := tx.QueryRow(ctx, "SELECT instance FROM workspace_integrations WHERE workspace_id=$1", b.Workspace.ID).Scan(&b.Integration.Instance)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, "SELECT project_id FROM approved_gitlab_projects WHERE workspace_id=$1 ORDER BY project_id", b.Workspace.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		b.Integration.Projects = append(b.Integration.Projects, id)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	rows, err = tx.Query(ctx, `SELECT e.id,e.project_id,e.kind,e.number,e.observation,e.last_success,e.last_attempt,e.outcome,e.next_refresh,(e.dirty OR e.outcome='refreshing'),
 ARRAY(SELECT item_id FROM item_external_links i WHERE i.workspace_id=e.workspace_id AND i.link_id=e.id ORDER BY item_id)
 FROM external_links e WHERE e.workspace_id=$1 ORDER BY e.project_id,e.kind,e.number`, b.Workspace.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var v p.ExternalLink
		var raw []byte
		if err = rows.Scan(&v.ID, &v.Project, &v.Kind, &v.Number, &raw, &v.LastSuccess, &v.LastAttempt, &v.Outcome, &v.NextRefresh, &v.RefreshPending, &v.Items); err != nil {
			rows.Close()
			return err
		}
		if len(raw) > 0 {
			if err = json.Unmarshal(raw, &v.Observation); err != nil {
				rows.Close()
				return err
			}
		}
		b.Links = append(b.Links, v)
	}
	rows.Close()
	return rows.Err()
}
func saveIntegration(ctx context.Context, tx pgx.Tx, b p.Board) error {
	wid := b.Workspace.ID
	ids := []string{}
	for _, l := range b.Links {
		ids = append(ids, l.ID)
	}
	if _, err := tx.Exec(ctx, "DELETE FROM item_external_links WHERE workspace_id=$1", wid); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM external_links WHERE workspace_id=$1 AND NOT(id=ANY($2::text[]))", wid, ids); err != nil {
		return err
	}
	projects := b.Integration.Projects
	if projects == nil {
		projects = []int64{}
	}
	if _, err := tx.Exec(ctx, "DELETE FROM approved_gitlab_projects WHERE workspace_id=$1 AND NOT(project_id=ANY($2::bigint[]))", wid, projects); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "INSERT INTO workspace_integrations VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET instance=excluded.instance", wid, b.Integration.Instance); err != nil {
		return err
	}
	for _, id := range projects {
		if _, err := tx.Exec(ctx, "INSERT INTO approved_gitlab_projects VALUES($1,$2) ON CONFLICT DO NOTHING", wid, id); err != nil {
			return err
		}
	}
	for _, link := range b.Links {
		// Never overwrite observations with a planning snapshot.
		if _, err := tx.Exec(ctx, `INSERT INTO external_links(workspace_id,id,project_id,kind,number) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,id) DO NOTHING`, wid, link.ID, link.Project, link.Kind, link.Number); err != nil {
			return err
		}
		for _, item := range link.Items {
			if _, err := tx.Exec(ctx, "INSERT INTO item_external_links VALUES($1,$2,$3)", wid, item, link.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

func lockRefresh(ctx context.Context, tx pgx.Tx, wid, subject string) (int64, error) {
	if _, err := role(ctx, tx, wid, subject); err != nil {
		return 0, err
	}
	var rev int64
	if err := tx.QueryRow(ctx, "SELECT revision FROM workspaces WHERE id=$1 FOR UPDATE", wid).Scan(&rev); err != nil {
		return 0, err
	}
	var r string
	err := tx.QueryRow(ctx, "SELECT role FROM memberships WHERE workspace_id=$1 AND subject=$2 FOR SHARE", wid, subject).Scan(&r)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && r == "viewer" {
		return 0, p.ErrForbidden
	}
	return rev, err
}

// refreshLink reserves an attempt under the workspace lock, fetches WITHOUT a
// database transaction, then checks authority and attempt identity before commit.
// Its observation never increments planning/item revisions or emits item events.
func (s *Store) refreshLink(ctx context.Context, wid, subject, key string, c p.Command) (int64, error) {
	return s.refresh(ctx, wid, subject, key, c, false)
}

// automatic is private service authority, never derived from an HTTP command,
// machine subject, or webhook payload. Workspace integration approval is required.
func (s *Store) refresh(ctx context.Context, wid, subject, key string, c p.Command, automatic bool) (int64, error) {
	lock := func(tx pgx.Tx) (int64, error) {
		if !automatic {
			return lockRefresh(ctx, tx, wid, subject)
		}
		var revision int64
		err := tx.QueryRow(ctx, "SELECT revision FROM workspaces WHERE id=$1 FOR UPDATE", wid).Scan(&revision)
		return revision, err
	}
	if len(key) < 16 || len(key) > 120 || len(c.Reason) > 4000 {
		return 0, p.ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	revision, err := lock(tx)
	if err != nil {
		return 0, err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return 0, err
	}
	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])
	var oldDigest string
	var oldRev int64
	err = pgx.ErrNoRows
	if !automatic {
		err = tx.QueryRow(ctx, "SELECT digest,revision FROM idempotency_keys WHERE workspace_id=$1 AND actor=$2 AND key=$3", wid, subject, key).Scan(&oldDigest, &oldRev)
	}
	if err == nil {
		if oldDigest != digest {
			return 0, p.ErrConflict
		}
		return oldRev, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	if !automatic && revision != c.Revision {
		return 0, p.ErrConflict
	}
	b := p.Board{Workspace: p.Workspace{ID: wid}}
	if err = loadIntegration(ctx, tx, &b); err != nil {
		return 0, err
	}
	if s.connector == nil || b.Integration.Instance != s.connector.Instance() {
		return 0, p.ErrInvalid
	}
	at := slices.IndexFunc(b.Links, func(l p.ExternalLink) bool { return l.ID == c.Target })
	if at < 0 {
		return 0, p.ErrNotFound
	}
	link := b.Links[at]
	if !slices.Contains(b.Integration.Projects, link.Project) {
		return 0, p.ErrForbidden
	}
	var eligible bool
	if err = tx.QueryRow(ctx, `SELECT (next_refresh IS NULL OR next_refresh<=clock_timestamp()) AND (NOT $3 OR dirty OR poll_after<=clock_timestamp()) FROM external_links WHERE workspace_id=$1 AND id=$2`, wid, link.ID, automatic).Scan(&eligible); err != nil {
		return 0, err
	}
	if !eligible {
		return 0, p.ErrConflict
	}
	// Finish an abandoned attempt before allocating the next generation.
	if _, err = tx.Exec(ctx, `UPDATE integration_runs SET outcome='interrupted',finished_at=now() WHERE id=(SELECT run_id FROM external_links WHERE workspace_id=$1 AND id=$2) AND outcome='pending'`, wid, link.ID); err != nil {
		return 0, err
	}
	var runID int64
	if err = tx.QueryRow(ctx, `INSERT INTO integration_runs(workspace_id,actor,key,digest,link_id,revision) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, wid, subject, key, digest, link.ID, revision).Scan(&runID); err != nil {
		return 0, err
	}
	trigger := "browser"
	if automatic {
		trigger = "background"
	}
	if _, err = tx.Exec(ctx, "UPDATE integration_runs SET trigger=$2 WHERE id=$1", runID, trigger); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `UPDATE external_links SET dirty=false,run_id=$3,last_attempt=clock_timestamp(),outcome='refreshing',next_refresh=clock_timestamp()+interval '30 seconds' WHERE workspace_id=$1 AND id=$2`, wid, link.ID, runID); err != nil {
		return 0, err
	}
	if !automatic {
		if _, err = tx.Exec(ctx, "INSERT INTO idempotency_keys VALUES($1,$2,$3,$4,$5)", wid, subject, key, digest, revision); err != nil {
			return 0, err
		}
	}
	detail, _ := json.Marshal(map[string]any{"link": link.ID, "run": runID, "reason": c.Reason, "trigger": trigger})
	if _, err = tx.Exec(ctx, `INSERT INTO audit_events(workspace_id,actor,action,request_id,after_state,outcome) VALUES($1,$2,'integration.refresh.request',$3,$4,'success')`, wid, subject, key, detail); err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	result := s.connector.Fetch(ctx, link.LinkTarget)
	finish, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = finish.Rollback(ctx) }()
	if _, err = lock(finish); err != nil {
		return 0, err
	}
	// Config revocation deletes cached links. Instance changes and superseded
	// attempts must never resurrect them, even when a late response is successful.
	var instance string
	var currentRun int64
	var failures int
	var previous []byte
	err = finish.QueryRow(ctx, `SELECT i.instance,e.run_id,e.failures,e.observation FROM external_links e JOIN workspace_integrations i USING(workspace_id) WHERE e.workspace_id=$1 AND e.id=$2`, wid, link.ID).Scan(&instance, &currentRun, &failures, &previous)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, p.ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if instance != s.connector.Instance() || currentRun != runID {
		return 0, p.ErrConflict
	}
	var old *p.Observation
	if len(previous) > 0 {
		if err = json.Unmarshal(previous, &old); err != nil {
			return 0, err
		}
	}
	if result.Outcome == "ok" && old != nil && old.SourceUpdatedAt != nil && result.Observation.SourceUpdatedAt != nil && result.Observation.SourceUpdatedAt.Before(*old.SourceUpdatedAt) {
		result.Outcome = "outdated"
	}
	if result.Outcome == "ok" && old != nil && old.HeadSHA == result.Observation.HeadSHA && old.Pipeline != nil && result.Observation.Pipeline != nil {
		previous, current := old.Pipeline, result.Observation.Pipeline
		if previous.ID == current.ID && previous.SourceUpdatedAt != nil && current.SourceUpdatedAt != nil && current.SourceUpdatedAt.Before(*previous.SourceUpdatedAt) {
			result.Outcome = "outdated"
		}
	}
	if result.Outcome == "ok" {
		failures = 0
	} else {
		failures = min(failures+1, 8)
	}
	cooldown := max(result.RetryAfter, retryBackoff(failures))
	poll := max(cooldown, s.refreshInterval+time.Duration(rand.Int64N(int64(max(s.refreshInterval/5, time.Second)))))
	observed, _ := json.Marshal(result.Observation)
	if _, err = finish.Exec(ctx, `UPDATE external_links SET observation=CASE WHEN $3='ok' THEN $4::jsonb ELSE observation END,last_success=CASE WHEN $3='ok' THEN clock_timestamp() ELSE last_success END,outcome=$3,next_refresh=clock_timestamp()+$5*interval '1 second',poll_after=clock_timestamp()+$6*interval '1 second',failures=$7 WHERE workspace_id=$1 AND id=$2`, wid, link.ID, result.Outcome, observed, cooldown.Seconds(), poll.Seconds(), failures); err != nil {
		return 0, err
	}
	if _, err = finish.Exec(ctx, `UPDATE integration_runs SET outcome=$2,finished_at=now() WHERE id=$1`, runID, result.Outcome); err != nil {
		return 0, err
	}
	detail, _ = json.Marshal(map[string]any{"link": link.ID, "run": runID, "outcome": result.Outcome, "trigger": trigger})
	if _, err = finish.Exec(ctx, `INSERT INTO audit_events(workspace_id,actor,action,request_id,after_state,outcome) VALUES($1,$2,'integration.refresh.result',$3,$4,'success')`, wid, subject, key, detail); err != nil {
		return 0, err
	}
	return revision, finish.Commit(ctx)
}

func retryBackoff(failures int) time.Duration {
	if failures == 0 {
		return 30 * time.Second
	}
	base := min(30*time.Second*time.Duration(1<<min(failures-1, 7)), time.Hour)
	return min(time.Hour, base+time.Duration(rand.Int64N(int64(base/5))))
}
