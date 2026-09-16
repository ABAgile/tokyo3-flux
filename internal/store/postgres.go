// Package store persists native planning records in PostgreSQL. No GitLab
// snapshot is used as a planning record or write authority.
package store

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"abagile.com/tokyo3/flux/internal/integration"
	p "abagile.com/tokyo3/flux/internal/planning"
	"github.com/abagile/tokyo3-base/cli"
	basedb "github.com/abagile/tokyo3-base/db"
	basetls "github.com/abagile/tokyo3-base/tls"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schema string

//go:embed 002_workspace.sql
var workspaceMigration string

//go:embed 003_labels.sql
var labelsMigration string

//go:embed 004_integrations.sql
var integrationsMigration string

//go:embed 005_refresh.sql
var refreshMigration string

//go:embed 006_proposals.sql
var proposalsMigration string

//go:embed 007_labels_priority.sql
var labelsPriorityMigration string

//go:embed 008_burndown.sql
var burndownMigration string

//go:embed 009_comments.sql
var commentsMigration string

//go:embed 010_attachments.sql
var attachmentsMigration string

type Store struct {
	refreshInterval time.Duration
	pool            *pgxpool.Pool
	connector       *integration.Client
}

// SetConnector is startup-only; the client is immutable apart from its bounded
// concurrency/rate-limit state. No credential is persisted.
func (s *Store) SetConnector(c *integration.Client) { s.connector = c }

func Open(ctx context.Context, material cli.DB) (*Store, error) {
	if strings.TrimSpace(material.URL) == "" || strings.HasPrefix(material.URL, "sqlite:") {
		return nil, errors.New("FLUX_DATABASE_URL must be a PostgreSQL DSN (SQLite is not supported yet)")
	}
	tlsConfig, err := basetls.FromFiles(material.CertFile, material.KeyFile, material.CAFile)
	if err != nil {
		return nil, fmt.Errorf("database TLS: %w", err)
	}
	pool, err := basedb.NewPgxPool(material.URL, func(c *pgxpool.Config) {
		configurePool(c, tlsConfig)
	})
	if err != nil {
		return nil, errors.New("invalid PostgreSQL configuration")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("PostgreSQL connection failed")
	}
	return &Store{pool: pool}, nil
}
func configurePool(c *pgxpool.Config, materialTLS *tls.Config) {
	c.MaxConns = 8
	c.ConnConfig.ConnectTimeout = 5 * time.Second
	if materialTLS != nil {
		// File-based identity must still verify the selected database hostname,
		// and must never inherit a plaintext sslmode=prefer fallback.
		c.ConnConfig.TLSConfig = materialTLS.Clone()
		c.ConnConfig.TLSConfig.ServerName = c.ConnConfig.Host
		c.ConnConfig.Fallbacks = nil
	}
}

func (s *Store) Close() { s.pool.Close() }
func (s *Store) Ready(ctx context.Context) error {
	var version int
	err := s.pool.QueryRow(ctx, "SELECT version FROM flux_schema").Scan(&version)
	if err != nil || version != 10 {
		return errors.New("native schema unavailable: run flux plan migrate")
	}
	return nil
}

// Migrate is explicit and serialized; serving never executes DDL.
func (s *Store) Migrate(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(742819306)"); err != nil {
		return err
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT to_regclass('flux_schema') IS NOT NULL").Scan(&exists); err != nil {
		return err
	}
	version := 1
	if exists {
		if err = tx.QueryRow(ctx, "SELECT version FROM flux_schema").Scan(&version); err != nil {
			return err
		}
		if version < 1 || version > 10 {
			return errors.New("unsupported native schema version")
		}
	} else if _, err = tx.Exec(ctx, schema); err != nil {
		return err
	}
	if version == 1 {
		if _, err = tx.Exec(ctx, workspaceMigration); err != nil {
			return err
		}
	}
	if version < 3 {
		if _, err = tx.Exec(ctx, labelsMigration); err != nil {
			return err
		}
	}
	if version < 4 {
		if _, err = tx.Exec(ctx, integrationsMigration); err != nil {
			return err
		}
	}
	if version < 5 {
		if _, err = tx.Exec(ctx, refreshMigration); err != nil {
			return err
		}
	}
	if version < 6 {
		if _, err = tx.Exec(ctx, proposalsMigration); err != nil {
			return err
		}
	}
	if version < 7 {
		if _, err = tx.Exec(ctx, labelsPriorityMigration); err != nil {
			return err
		}
	}
	if version < 8 {
		if _, err = tx.Exec(ctx, burndownMigration); err != nil {
			return err
		}
	}
	if version < 9 {
		if _, err = tx.Exec(ctx, commentsMigration); err != nil {
			return err
		}
	}
	if version < 10 {
		if _, err = tx.Exec(ctx, attachmentsMigration); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Bootstrap is an operator-only command, never an HTTP registration endpoint.
func (s *Store) Bootstrap(ctx context.Context, name, project, subject string) (p.Workspace, error) {
	var result p.Workspace
	if strings.TrimSpace(name) == "" || len(name) > 120 || len(project) > 120 || strings.TrimSpace(subject) == "" || len(subject) > 200 {
		return result, fmt.Errorf("%w: workspace name and admin subject required; project is optional", p.ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	wid, pid := p.NewID(), p.NewID()
	result = p.Workspace{ID: wid, Name: name, Role: "admin", Revision: 1}
	if _, err = tx.Exec(ctx, "INSERT INTO workspaces(id,name) VALUES($1,$2)", wid, name); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO memberships(workspace_id,subject,role) VALUES($1,$2,'admin')", wid, subject); err != nil {
		return result, err
	}
	if strings.TrimSpace(project) != "" {
		if _, err = tx.Exec(ctx, "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)", pid, wid, project); err != nil {
			return result, err
		}
	}
	for i, c := range []struct {
		name, category string
		wip            int
	}{{"Ready", "todo", 0}, {"In progress", "doing", 3}, {"In review", "doing", 3}, {"Done", "done", 0}} {
		if _, err = tx.Exec(ctx, "INSERT INTO board_columns(workspace_id,id,name,category,position,wip) VALUES($1,$2,$3,$4,$5,$6)", wid, p.NewID(), c.name, c.category, i, c.wip); err != nil {
			return result, err
		}
	}
	after, _ := json.Marshal(map[string]any{"workspace": result, "initial_project": project, "admin_subject": subject})
	if _, err = tx.Exec(ctx, "INSERT INTO audit_events(workspace_id,actor,action,request_id,after_state,outcome) VALUES($1,'database:' || current_user,'workspace.bootstrap',$2,$3,'success')", wid, p.NewID(), after); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

func (s *Store) Workspaces(ctx context.Context, subject string) ([]p.Workspace, error) {
	rows, err := s.pool.Query(ctx, "SELECT w.id,w.name,m.role,w.revision FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.subject=$1 ORDER BY w.name,w.id LIMIT 101", subject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []p.Workspace{}
	for rows.Next() {
		var v p.Workspace
		if err = rows.Scan(&v.ID, &v.Name, &v.Role, &v.Revision); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if len(out) > 100 {
		return nil, errors.New("workspace list exceeds supported limit")
	}
	return out, rows.Err()
}
func (s *Store) Projects(ctx context.Context, wid, subject string) ([]p.Project, error) {
	if _, err := role(ctx, s.pool, wid, subject); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, "SELECT id,workspace_id,name,revision FROM projects WHERE workspace_id=$1 ORDER BY name,id LIMIT 101", wid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []p.Project{}
	for rows.Next() {
		var v p.Project
		if err = rows.Scan(&v.ID, &v.WorkspaceID, &v.Name, &v.Revision); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if len(out) > 100 {
		return nil, errors.New("project list exceeds supported limit")
	}
	return out, rows.Err()
}

// GitLabUsers returns the connector's active user catalog to workspace
// administrators. It is a picker source, not persisted planning state.
func (s *Store) GitLabUsers(ctx context.Context, wid, subject, search string) ([]p.GitLabUser, error) {
	memberRole, err := role(ctx, s.pool, wid, subject)
	if err != nil {
		return nil, err
	}
	if memberRole != "admin" {
		return nil, p.ErrForbidden
	}
	if s.connector == nil {
		return nil, p.ErrGitLabUnavailable
	}
	users, err := s.connector.Users(ctx, search)
	if err != nil {
		return nil, p.ErrGitLabUnavailable
	}
	out := make([]p.GitLabUser, 0, len(users))
	for _, user := range users {
		out = append(out, p.GitLabUser{ID: user.ID, Username: user.Username, Name: user.Name, AvatarURL: user.AvatarURL})
	}
	return out, nil
}

// GitLabProjects returns the full connector catalog to admins and only
// approved projects to other workspace members. It is a picker source, not
// persisted planning state.
func (s *Store) GitLabProjects(ctx context.Context, wid, subject string) ([]p.GitLabProject, error) {
	memberRole, err := role(ctx, s.pool, wid, subject)
	if err != nil {
		return nil, err
	}
	if s.connector == nil {
		return nil, p.ErrGitLabUnavailable
	}
	approved := map[int64]bool{}
	if memberRole != "admin" {
		var instance string
		if queryErr := s.pool.QueryRow(ctx, "SELECT instance FROM workspace_integrations WHERE workspace_id=$1", wid).Scan(&instance); errors.Is(queryErr, pgx.ErrNoRows) {
			return []p.GitLabProject{}, nil
		} else if queryErr != nil {
			return nil, queryErr
		} else if instance != s.connector.Instance() {
			return []p.GitLabProject{}, nil
		}
		rows, queryErr := s.pool.Query(ctx, "SELECT project_id FROM approved_gitlab_projects WHERE workspace_id=$1", wid)
		if queryErr != nil {
			return nil, queryErr
		}
		for rows.Next() {
			var id int64
			if queryErr = rows.Scan(&id); queryErr != nil {
				rows.Close()
				return nil, queryErr
			}
			approved[id] = true
		}
		if queryErr = rows.Err(); queryErr != nil {
			rows.Close()
			return nil, queryErr
		}
		rows.Close()
		if len(approved) == 0 {
			return []p.GitLabProject{}, nil
		}
	}
	projects, err := s.connector.Projects(ctx)
	if err != nil {
		return nil, p.ErrGitLabUnavailable
	}
	out := make([]p.GitLabProject, 0, len(projects))
	for _, project := range projects {
		if memberRole != "admin" && !approved[project.ID] {
			continue
		}
		out = append(out, p.GitLabProject{ID: project.ID, Name: project.Name, PathWithNamespace: project.PathWithNamespace})
	}
	return out, nil
}

const maxGitLabAssigneeIDs = 50

// GitLabMergeRequests searches only approved project coordinates. The
// provider credential remains server-side and viewers cannot use this picker
// to create links. Recent is the unfiltered compatibility default.
func (s *Store) GitLabMergeRequests(ctx context.Context, wid, subject string, projectID int64, search string) ([]p.GitLabMergeRequest, error) {
	return s.GitLabMergeRequestsFor(ctx, wid, subject, projectID, search, "recent")
}

// GitLabMergeRequestsFor applies a workspace-safe quick scope. GitLab's
// assigned_to_me scope would refer to the server connector account, so the
// store resolves Flux membership subjects to explicit GitLab assignee IDs.
func (s *Store) GitLabMergeRequestsFor(ctx context.Context, wid, subject string, projectID int64, search, scope string) ([]p.GitLabMergeRequest, error) {
	memberRole, err := role(ctx, s.pool, wid, subject)
	if err != nil {
		return nil, err
	}
	if memberRole == "viewer" {
		return nil, p.ErrForbidden
	}
	if scope != "recent" && scope != "assigned_to_me" && scope != "board_members" {
		return nil, p.ErrInvalid
	}
	if s.connector == nil {
		return nil, p.ErrGitLabUnavailable
	}
	var approved bool
	if err = s.pool.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM approved_gitlab_projects a
		JOIN workspace_integrations i USING(workspace_id)
		WHERE a.workspace_id=$1 AND a.project_id=$2 AND i.instance=$3
	)`, wid, projectID, s.connector.Instance()).Scan(&approved); err != nil {
		return nil, err
	}
	if !approved {
		return nil, p.ErrForbidden
	}
	assigneeIDs, err := s.gitLabAssigneeIDs(ctx, wid, subject, scope)
	if err != nil {
		return nil, err
	}
	if scope != "recent" && len(assigneeIDs) == 0 {
		return []p.GitLabMergeRequest{}, nil
	}
	mergeRequests, err := s.connector.MergeRequests(ctx, projectID, search, assigneeIDs...)
	if err != nil {
		return nil, p.ErrGitLabUnavailable
	}
	out := make([]p.GitLabMergeRequest, 0, len(mergeRequests))
	for _, mergeRequest := range mergeRequests {
		out = append(out, p.GitLabMergeRequest{ProjectID: projectID, IID: mergeRequest.IID, Title: mergeRequest.Title, State: mergeRequest.State, Draft: mergeRequest.Draft, UpdatedAt: mergeRequest.UpdatedAt})
	}
	return out, nil
}

func (s *Store) gitLabAssigneeIDs(ctx context.Context, wid, subject, scope string) ([]int64, error) {
	if scope == "recent" {
		return nil, nil
	}
	if scope == "assigned_to_me" {
		if id, ok := gitLabUserID(subject); ok {
			return []int64{id}, nil
		}
		return []int64{}, nil
	}
	rows, err := s.pool.Query(ctx, "SELECT subject FROM memberships WHERE workspace_id=$1 ORDER BY subject", wid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]int64, 0)
	seen := map[int64]struct{}{}
	for rows.Next() {
		var member string
		if err := rows.Scan(&member); err != nil {
			return nil, err
		}
		id, ok := gitLabUserID(member)
		if !ok {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
		if len(ids) > maxGitLabAssigneeIDs {
			return nil, fmt.Errorf("%w: board has too many GitLab members", p.ErrInvalid)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

func gitLabUserID(subject string) (int64, bool) {
	id, err := strconv.ParseInt(subject, 10, 64)
	return id, err == nil && id > 0 && id <= p.MaxExternalID
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func role(ctx context.Context, q querier, wid, subject string) (string, error) {
	var r string
	err := q.QueryRow(ctx, "SELECT role FROM memberships WHERE workspace_id=$1 AND subject=$2", wid, subject).Scan(&r)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", p.ErrForbidden
	}
	return r, err
}

func (s *Store) Board(ctx context.Context, wid, subject string) (p.Board, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return p.Board{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	b, err := load(ctx, tx, wid, subject)
	if err != nil {
		return b, err
	}
	b.ConnectorInstance = s.connector.Instance()
	b.RefreshSeconds = int64(s.refreshInterval / time.Second)
	if err := tx.Commit(ctx); err != nil {
		return b, err
	}
	s.enrichMembers(ctx, &b)
	return b, nil
}

func (s *Store) enrichMembers(ctx context.Context, b *p.Board) {
	if s.connector == nil || len(b.Members) == 0 {
		return
	}
	subjects := make([]string, 0, len(b.Members))
	for _, member := range b.Members {
		subjects = append(subjects, member.Subject)
	}
	profileCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	profiles := s.connector.Profiles(profileCtx, subjects)
	for i := range b.Members {
		profile, ok := profiles[b.Members[i].Subject]
		if !ok {
			continue
		}
		if strings.TrimSpace(b.Members[i].Name) == "" {
			b.Members[i].Name = profile.Name
		}
		b.Members[i].Username = profile.Username
		b.Members[i].AvatarURL = profile.AvatarURL
	}
}

func load(ctx context.Context, tx pgx.Tx, wid, subject string) (p.Board, error) {
	b := p.Board{Labels: []p.Label{}, Projects: []p.Project{}, Columns: []p.Column{}, Items: []p.Item{}, Sprints: []p.Sprint{}, Members: []p.Member{}, ClosedScope: []p.Scope{}}
	r, err := role(ctx, tx, wid, subject)
	if err != nil {
		return b, err
	}
	b.Role = r
	b.Workspace.Role = r
	query := "SELECT id,name,revision FROM workspaces WHERE id=$1"
	if err = tx.QueryRow(ctx, query, wid).Scan(&b.Workspace.ID, &b.Workspace.Name, &b.Workspace.Revision); errors.Is(err, pgx.ErrNoRows) {
		return b, p.ErrNotFound
	} else if err != nil {
		return b, err
	}
	rows, err := tx.Query(ctx, "SELECT id,name,category,position,wip FROM board_columns WHERE workspace_id=$1 ORDER BY position,id", wid)
	if err != nil {
		return b, err
	}
	for rows.Next() {
		var v p.Column
		if err = rows.Scan(&v.ID, &v.Name, &v.Category, &v.Position, &v.WIP); err != nil {
			rows.Close()
			return b, err
		}
		b.Columns = append(b.Columns, v)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return b, err
	}
	rows, err = tx.Query(ctx, "SELECT id,name,goal,to_char(start_date,'YYYY-MM-DD'),to_char(end_date,'YYYY-MM-DD'),state,revision FROM sprints WHERE workspace_id=$1 ORDER BY start_date,id", wid)
	if err != nil {
		return b, err
	}
	for rows.Next() {
		var v p.Sprint
		if err = rows.Scan(&v.ID, &v.Name, &v.Goal, &v.Start, &v.End, &v.State, &v.Revision); err != nil {
			rows.Close()
			return b, err
		}
		b.Sprints = append(b.Sprints, v)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return b, err
	}
	rows, err = tx.Query(ctx, `SELECT i.id,i.title,i.description,i.column_id,coalesce(i.project_id,''),coalesce(i.assignee,''),i.rank,i.revision,i.archived,
 ARRAY(SELECT label FROM item_labels l WHERE l.workspace_id=i.workspace_id AND l.item_id=i.id ORDER BY label),
 ARRAY(SELECT depends_on FROM dependencies d WHERE d.workspace_id=i.workspace_id AND d.item_id=i.id ORDER BY depends_on),
 ARRAY(SELECT sprint_id FROM item_sprints s WHERE s.workspace_id=i.workspace_id AND s.item_id=i.id ORDER BY sprint_id)
 FROM work_items i WHERE i.workspace_id=$1 ORDER BY rank,id LIMIT 1001`, wid)
	if err != nil {
		return b, err
	}
	for rows.Next() {
		var v p.Item
		if err = rows.Scan(&v.ID, &v.Title, &v.Description, &v.ColumnID, &v.ProjectID, &v.Assignee, &v.Rank, &v.Revision, &v.Archived, &v.Labels, &v.Dependencies, &v.SprintIDs); err != nil {
			rows.Close()
			return b, err
		}
		v.Attachments = []p.Attachment{}
		b.Items = append(b.Items, v)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return b, err
	}
	itemIndexes := make(map[string]int, len(b.Items))
	for index := range b.Items {
		itemIndexes[b.Items[index].ID] = index
	}
	rows, err = tx.Query(ctx, `SELECT id,item_id,storage_key,name,content_type,size,digest,uploader,created_at
 FROM item_attachments WHERE workspace_id=$1 ORDER BY item_id,id LIMIT $2`, wid,
		p.MaxWorkspaceAttachments+1)
	if err != nil {
		return b, err
	}
	attachmentCount := 0
	for rows.Next() {
		attachmentCount++
		if attachmentCount > p.MaxWorkspaceAttachments {
			rows.Close()
			return b, errors.New("workspace exceeds supported attachment limit")
		}
		var attachment p.Attachment
		if err = rows.Scan(&attachment.ID, &attachment.ItemID, &attachment.StorageKey,
			&attachment.Name, &attachment.ContentType, &attachment.Size, &attachment.Digest,
			&attachment.Uploader, &attachment.CreatedAt); err != nil {
			rows.Close()
			return b, err
		}
		if !validAttachmentStorageKey(attachment.StorageKey) || strings.TrimSpace(attachment.Uploader) == "" || validateAttachmentMetadata(attachment) != nil {
			rows.Close()
			return b, errors.New("workspace contains invalid attachment metadata")
		}
		index, ok := itemIndexes[attachment.ItemID]
		if !ok {
			rows.Close()
			return b, errors.New("attachment references an unknown workspace item")
		}
		if len(b.Items[index].Attachments) >= p.MaxItemAttachments {
			rows.Close()
			return b, errors.New("workspace exceeds supported item attachment limit")
		}
		b.Items[index].Attachments = append(b.Items[index].Attachments, attachment)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return b, err
	}
	if len(b.Items) > p.MaxItems {
		return b, errors.New("workspace exceeds supported item limit")
	}
	rows, err = tx.Query(ctx, "SELECT subject,role,name FROM memberships WHERE workspace_id=$1 ORDER BY subject", wid)
	if err != nil {
		return b, err
	}
	for rows.Next() {
		var v p.Member
		if err = rows.Scan(&v.Subject, &v.Role, &v.Name); err != nil {
			rows.Close()
			return b, err
		}
		b.Members = append(b.Members, v)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return b, err
	}
	rows, err = tx.Query(ctx, "SELECT name,color FROM workspace_labels WHERE workspace_id=$1 ORDER BY name", wid)
	if err != nil {
		return b, err
	}
	for rows.Next() {
		var label p.Label
		if err = rows.Scan(&label.Name, &label.Color); err != nil {
			rows.Close()
			return b, err
		}
		b.Labels = append(b.Labels, label)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return b, err
	}
	rows, err = tx.Query(ctx, "SELECT sprint_id,item_id FROM closed_sprint_scope WHERE workspace_id=$1 ORDER BY sprint_id,item_id", wid)
	if err != nil {
		return b, err
	}
	for rows.Next() {
		var v p.Scope
		if err = rows.Scan(&v.SprintID, &v.ItemID); err != nil {
			rows.Close()
			return b, err
		}
		b.ClosedScope = append(b.ClosedScope, v)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return b, err
	}
	rows, err = tx.Query(ctx, "SELECT id,workspace_id,name,revision FROM projects WHERE workspace_id=$1 ORDER BY name,id", wid)
	if err != nil {
		return b, err
	}
	for rows.Next() {
		var v p.Project
		if err = rows.Scan(&v.ID, &v.WorkspaceID, &v.Name, &v.Revision); err != nil {
			rows.Close()
			return b, err
		}
		b.Projects = append(b.Projects, v)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return b, err
	}
	b.Imported = []p.ImportReceipt{}
	rows, err = tx.Query(ctx, "SELECT source,item_id,proposal_id FROM imported_items WHERE workspace_id=$1 ORDER BY source", wid)
	if err != nil {
		return b, err
	}
	for rows.Next() {
		var v p.ImportReceipt
		if err = rows.Scan(&v.Source, &v.ItemID, &v.ProposalID); err != nil {
			rows.Close()
			return b, err
		}
		b.Imported = append(b.Imported, v)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return b, err
	}
	if err = loadIntegration(ctx, tx, &b); err != nil {
		return b, err
	}
	return b, nil
}

// Change serializes workspace mutations before checking revision and WIP. Domain
// rows, event history, audit and idempotency receipt share one commit.
func (s *Store) Change(ctx context.Context, wid, subject, key string, c p.Command) (int64, error) {
	if c.Kind == "link.refresh" {
		return s.refreshLink(ctx, wid, subject, key, c)
	}
	if len(key) < 16 || len(key) > 120 {
		return 0, fmt.Errorf("%w: Idempotency-Key must be 16–120 characters", p.ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Both planning and membership changes lock workspace before membership.
	// Recheck permission after locking so concurrent revocation is linearized.
	if _, err = role(ctx, tx, wid, subject); err != nil {
		return 0, err
	}
	var locked string
	if err = tx.QueryRow(ctx, "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", wid).Scan(&locked); err != nil {
		return 0, err
	}
	var memberRole string
	err = tx.QueryRow(ctx, "SELECT role FROM memberships WHERE workspace_id=$1 AND subject=$2 FOR SHARE", wid, subject).Scan(&memberRole)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && memberRole == "viewer") {
		return 0, p.ErrForbidden
	}
	if err != nil {
		return 0, err
	}
	b, err := load(ctx, tx, wid, subject)
	if err != nil {
		return 0, err
	}
	if c.Item != nil {
		item := *c.Item
		item.Attachments = nil
		c.Item = &item
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return 0, err
	}
	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])
	var oldDigest string
	var revision int64
	err = tx.QueryRow(ctx, "SELECT digest,revision FROM idempotency_keys WHERE workspace_id=$1 AND actor=$2 AND key=$3", wid, subject, key).Scan(&oldDigest, &revision)
	if err == nil {
		if oldDigest != digest {
			return 0, p.ErrConflict
		}
		return revision, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	if strings.HasPrefix(c.Kind, "proposal.") {
		return s.changeProposal(ctx, tx, b, subject, key, digest, c)
	}
	before, err := json.Marshal(planningSnapshot(b))
	if err != nil {
		return 0, err
	}
	// The instance is an operator authority, not a browser-supplied fetch URL.
	if c.Kind == "integration.save" && c.Integration != nil {
		cfg := *c.Integration
		if len(cfg.Projects) > 0 && cfg.Instance != s.connector.Instance() {
			return 0, p.ErrConflict
		}
		cfg.Instance = s.connector.Instance()
		if len(cfg.Projects) == 0 {
			cfg.Instance = ""
		}
		c.Integration = &cfg
	}
	if c.Kind == "link.attach" && (s.connector == nil || b.Integration.Instance != s.connector.Instance()) {
		return 0, p.ErrInvalid
	}
	if err = p.Apply(&b, c); err != nil {
		return 0, err
	}
	switch c.Kind {
	case "member.name":
		if _, err = tx.Exec(ctx, "UPDATE memberships SET name=$3 WHERE workspace_id=$1 AND subject=$2", wid, c.Target, strings.TrimSpace(c.Name)); err != nil {
			return 0, err
		}
	case "member.save":
		subject := strings.TrimSpace(c.Target)
		if subject == "" && c.Member != nil {
			subject = strings.TrimSpace(c.Member.Subject)
		}
		var member p.Member
		found := false
		for _, candidate := range b.Members {
			if candidate.Subject == subject {
				member, found = candidate, true
				break
			}
		}
		if !found {
			return 0, p.ErrNotFound
		}
		if c.Target == "" {
			_, err = tx.Exec(ctx, "INSERT INTO memberships(workspace_id,subject,role,name) VALUES($1,$2,$3,$4)", wid, member.Subject, member.Role, member.Name)
		} else {
			_, err = tx.Exec(ctx, "UPDATE memberships SET role=$3,name=$4 WHERE workspace_id=$1 AND subject=$2", wid, member.Subject, member.Role, member.Name)
		}
		if err != nil {
			return 0, err
		}
	case "member.delete":
		if _, err = tx.Exec(ctx, "DELETE FROM memberships WHERE workspace_id=$1 AND subject=$2", wid, strings.TrimSpace(c.Target)); err != nil {
			return 0, err
		}
	}
	if err = save(ctx, tx, b); err != nil {
		return 0, err
	}
	target := c.Target
	if target == "" {
		switch c.Kind {
		case "item.create":
			target = b.Items[len(b.Items)-1].ID
		case "column.save":
			target = b.Columns[len(b.Columns)-1].ID
		case "sprint.save":
			target = b.Sprints[len(b.Sprints)-1].ID
		case "project.save":
			target = b.Projects[len(b.Projects)-1].ID
		case "member.save":
			if c.Member != nil {
				target = strings.TrimSpace(c.Member.Subject)
			}
		case "label.save":
			target = c.Name
		}
	}
	if _, err = tx.Exec(ctx, "INSERT INTO work_item_events(workspace_id,revision,actor,action,target,reason) VALUES($1,$2,$3,$4,$5,$6)", wid, b.Workspace.Revision, subject, c.Kind, target, c.Reason); err != nil {
		return 0, err
	}
	after, err := json.Marshal(planningSnapshot(b))
	if err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO audit_events(workspace_id,actor,action,request_id,before_state,after_state,outcome) VALUES($1,$2,$3,$4,$5,$6,'success')", wid, subject, c.Kind, key, before, after); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO idempotency_keys VALUES($1,$2,$3,$4,$5)", wid, subject, key, digest, b.Workspace.Revision); err != nil {
		return 0, err
	}
	return b.Workspace.Revision, tx.Commit(ctx)
}

// save writes normalized rows, not an authoritative JSON board snapshot. The
// deliberately small MVP board is locked and bounded to 1000 items.
func save(ctx context.Context, tx pgx.Tx, b p.Board) error {
	wid := b.Workspace.ID
	for _, project := range b.Projects {
		if _, err := tx.Exec(ctx, `INSERT INTO projects(id,workspace_id,name,revision) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision`, project.ID, wid, project.Name, project.Revision); err != nil {
			return err
		}
	}
	for _, c := range b.Columns {
		if _, err := tx.Exec(ctx, `INSERT INTO board_columns(workspace_id,id,name,category,position,wip) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,id) DO UPDATE SET name=excluded.name,category=excluded.category,position=excluded.position,wip=excluded.wip`, wid, c.ID, c.Name, c.Category, c.Position, c.WIP); err != nil {
			return err
		}
	}
	// Sprints and project classification share the workspace transaction.
	for _, sp := range b.Sprints {
		if _, err := tx.Exec(ctx, `INSERT INTO sprints(workspace_id,id,name,goal,start_date,end_date,state,revision) VALUES($1,$2,$3,$4,$5::date,$6::date,$7,$8) ON CONFLICT(workspace_id,id) DO UPDATE SET name=excluded.name,goal=excluded.goal,start_date=excluded.start_date,end_date=excluded.end_date,state=excluded.state,revision=excluded.revision`, wid, sp.ID, sp.Name, sp.Goal, sp.Start, sp.End, sp.State, sp.Revision); err != nil {
			return err
		}
	}
	for _, it := range b.Items {
		if _, err := tx.Exec(ctx, `INSERT INTO work_items(workspace_id,project_id,id,title,description,column_id,assignee,rank,revision,archived) VALUES($1,NULLIF($2,''),$3,$4,$5,$6,NULLIF($7,''),$8,$9,$10) ON CONFLICT(workspace_id,id) DO UPDATE SET title=excluded.title,description=excluded.description,column_id=excluded.column_id,project_id=excluded.project_id,assignee=excluded.assignee,rank=excluded.rank,revision=excluded.revision,archived=excluded.archived`, wid, it.ProjectID, it.ID, it.Title, it.Description, it.ColumnID, it.Assignee, it.Rank, it.Revision, it.Archived); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, "DELETE FROM item_labels WHERE workspace_id=$1", wid); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM workspace_labels WHERE workspace_id=$1", wid); err != nil {
		return err
	}
	for _, label := range b.Labels {
		if _, err := tx.Exec(ctx, "INSERT INTO workspace_labels(workspace_id,name,color) VALUES($1,$2,$3)", wid, label.Name, label.Color); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, "DELETE FROM dependencies WHERE workspace_id=$1", wid); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM item_sprints WHERE workspace_id=$1", wid); err != nil {
		return err
	}
	for _, it := range b.Items {
		for _, sid := range it.SprintIDs {
			if _, err := tx.Exec(ctx, "INSERT INTO item_sprints(workspace_id,item_id,sprint_id) VALUES($1,$2,$3)", wid, it.ID, sid); err != nil {
				return err
			}
		}
		for _, label := range it.Labels {
			if _, err := tx.Exec(ctx, "INSERT INTO item_labels(workspace_id,item_id,label) VALUES($1,$2,$3)", wid, it.ID, label); err != nil {
				return err
			}
		}
		for _, dep := range it.Dependencies {
			if _, err := tx.Exec(ctx, "INSERT INTO dependencies(workspace_id,item_id,depends_on) VALUES($1,$2,$3)", wid, it.ID, dep); err != nil {
				return err
			}
		}
	}
	ids := []string{}
	for _, c := range b.Columns {
		ids = append(ids, c.ID)
	}
	if _, err := tx.Exec(ctx, "DELETE FROM board_columns WHERE workspace_id=$1 AND NOT(id=ANY($2::text[]))", wid, ids); err != nil {
		return err
	}
	for _, scope := range b.ClosedScope {
		if _, err := tx.Exec(ctx, "INSERT INTO closed_sprint_scope(workspace_id,sprint_id,item_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", wid, scope.SprintID, scope.ItemID); err != nil {
			return err
		}
	}
	if err := saveIntegration(ctx, tx, b); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, "UPDATE workspaces SET revision=$2 WHERE id=$1", wid, b.Workspace.Revision)
	return err
}

func (s *Store) History(ctx context.Context, wid, subject string, before int64) ([]p.Event, error) {
	if _, err := role(ctx, s.pool, wid, subject); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, "SELECT id,actor,action,target,reason,at,revision,coalesce(project_id,'') FROM work_item_events WHERE workspace_id=$1 AND ($2::bigint=0 OR id<$2) ORDER BY id DESC LIMIT 50", wid, before)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []p.Event{}
	for rows.Next() {
		var v p.Event
		if err = rows.Scan(&v.ID, &v.Actor, &v.Action, &v.Target, &v.Reason, &v.At, &v.Revision, &v.LegacyProjectID); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// SetMember is operator-only for this release. It takes an exclusive workspace
// membership lock and refuses to remove the last administrator.
func (s *Store) SetMember(ctx context.Context, wid, subject, memberRole string) error {
	if subject == "" || len(subject) > 200 || (memberRole != "viewer" && memberRole != "member" && memberRole != "admin") {
		return p.ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err = tx.QueryRow(ctx, "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", wid).Scan(&id); err != nil {
		return err
	}
	var old string
	err = tx.QueryRow(ctx, "SELECT role FROM memberships WHERE workspace_id=$1 AND subject=$2 FOR UPDATE", wid, subject).Scan(&old)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if old == "admin" && memberRole != "admin" {
		var count int
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM memberships WHERE workspace_id=$1 AND role='admin'", wid).Scan(&count); err != nil {
			return err
		}
		if count <= 1 {
			return fmt.Errorf("%w: keep one administrator", p.ErrInvalid)
		}
	}
	if _, err = tx.Exec(ctx, "INSERT INTO memberships(workspace_id,subject,role) VALUES($1,$2,$3) ON CONFLICT(workspace_id,subject) DO UPDATE SET role=excluded.role", wid, subject, memberRole); err != nil {
		return err
	}
	detail, _ := json.Marshal(p.Member{Subject: subject, Role: memberRole})
	if _, err = tx.Exec(ctx, "INSERT INTO audit_events(workspace_id,actor,action,request_id,after_state,outcome) VALUES($1,'database:' || current_user,'membership.set',$2,$3,'success')", wid, p.NewID(), detail); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
