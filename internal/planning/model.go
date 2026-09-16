// Package planning owns native Flux planning rules, independently of GitLab.
package planning

import (
	"crypto/rand"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

var (
	ErrInvalid               = errors.New("invalid planning change")
	ErrConflict              = errors.New("planning changed; refresh and review before saving")
	ErrForbidden             = errors.New("workspace permission denied")
	ErrNotFound              = errors.New("planning record not found")
	ErrAttachmentUnavailable = errors.New("attachment storage unavailable")
	ErrGitLabUnavailable     = errors.New("GitLab connector unavailable")
)

const (
	MaxItems                = 1000
	MaxCommentLength        = 4000
	MaxItemComments         = 500
	MaxAttachmentBytes      = 20 << 20
	MaxItemAttachments      = 100
	MaxWorkspaceAttachments = 10000
	MaxAttachmentName       = 255
	MaxAttachmentMIME       = 255
	DefaultLabelColor       = "#dcefe4"
)

type Workspace struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	Revision int64  `json:"revision"`
}
type Member struct {
	Name      string `json:"name"`
	Subject   string `json:"subject"`
	Role      string `json:"role"`
	AvatarURL string `json:"avatar_url,omitempty"`
}
type Label struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}
type Project struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	Name        string `json:"name"`
	Revision    int64  `json:"revision"`
}
type GitLabProject struct {
	ID                int64  `json:"id"`
	Name              string `json:"name"`
	PathWithNamespace string `json:"path_with_namespace"`
}
type GitLabMergeRequest struct {
	ProjectID int64      `json:"project_id"`
	IID       int64      `json:"iid"`
	Title     string     `json:"title"`
	State     string     `json:"state"`
	Draft     bool       `json:"draft"`
	UpdatedAt *time.Time `json:"updated_at,omitempty"`
}
type Column struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Category string `json:"category"`
	Position int    `json:"position"`
	WIP      int    `json:"wip"`
}
type Item struct {
	ID           string       `json:"id"`
	Title        string       `json:"title"`
	Description  string       `json:"description"`
	ColumnID     string       `json:"column_id"`
	ProjectID    string       `json:"project_id"`
	SprintIDs    []string     `json:"sprint_ids"`
	Assignee     string       `json:"assignee"`
	Rank         int          `json:"rank"`
	Revision     int64        `json:"revision"`
	Archived     bool         `json:"archived"`
	Labels       []string     `json:"labels"`
	Dependencies []string     `json:"dependencies"`
	Attachments  []Attachment `json:"attachments,omitempty"`
}
type Attachment struct {
	ID          int64     `json:"id"`
	ItemID      string    `json:"item_id"`
	Name        string    `json:"name"`
	ContentType string    `json:"content_type"`
	Size        int64     `json:"size"`
	Digest      string    `json:"digest"`
	Uploader    string    `json:"uploader"`
	CreatedAt   time.Time `json:"created_at"`
	StorageKey  string    `json:"-"`
}
type Comment struct {
	ID        int64     `json:"id"`
	ItemID    string    `json:"item_id"`
	Author    string    `json:"author"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
}
type Sprint struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Goal     string `json:"goal"`
	Start    string `json:"start"`
	End      string `json:"end"`
	State    string `json:"state"`
	Revision int64  `json:"revision"`
}
type Scope struct {
	SprintID string `json:"sprint_id"`
	ItemID   string `json:"item_id"`
}
type ImportReceipt struct {
	Source     string `json:"source"`
	ItemID     string `json:"item_id"`
	ProposalID string `json:"proposal_id"`
}
type Board struct {
	Imported          []ImportReceipt `json:"imported"`
	RefreshSeconds    int64           `json:"refresh_seconds"`
	Integration       Integration     `json:"integration"`
	ConnectorInstance string          `json:"connector_instance"`
	Links             []ExternalLink  `json:"links"`
	Labels            []Label         `json:"labels"`
	Workspace         Workspace       `json:"workspace"`
	Projects          []Project       `json:"projects"`
	Role              string          `json:"role"`
	Columns           []Column        `json:"columns"`
	Items             []Item          `json:"items"`
	Sprints           []Sprint        `json:"sprints"`
	Members           []Member        `json:"members"`
	ClosedScope       []Scope         `json:"closed_scope"`
}
type Event struct {
	LegacyProjectID string    `json:"legacy_project_id,omitempty"`
	ID              int64     `json:"id"`
	Actor           string    `json:"actor"`
	Action          string    `json:"action"`
	Target          string    `json:"target"`
	Reason          string    `json:"reason"`
	At              time.Time `json:"at"`
	Revision        int64     `json:"revision"`
}

// Command is a bounded, typed mutation. Revision protects the entire board,
// including ordering, sprint scope, and WIP decisions across multiple cards.
type Command struct {
	Proposal    *ProposalDocument `json:"proposal,omitempty"`
	Integration *Integration      `json:"integration,omitempty"`
	Link        *LinkTarget       `json:"link,omitempty"`
	Name        string            `json:"name,omitempty"`
	Color       string            `json:"color,omitempty"`
	Kind        string            `json:"kind"`
	Revision    int64             `json:"revision"`
	Target      string            `json:"target"`
	Item        *Item             `json:"item,omitempty"`
	Column      *Column           `json:"column,omitempty"`
	Sprint      *Sprint           `json:"sprint,omitempty"`
	Project     *Project          `json:"project,omitempty"`
	Before      string            `json:"before,omitempty"`
	Destination string            `json:"destination,omitempty"`
	Reason      string            `json:"reason,omitempty"`
}

func NewID() string { return rand.Text() }

func invalid(s string) error { return fmt.Errorf("%w: %s", ErrInvalid, s) }

func validLabelName(name string) bool {
	if strings.TrimSpace(name) == "" || len(name) > 60 || strings.ContainsAny(name, "\r\n") {
		return false
	}
	for scope := range strings.SplitSeq(name, "::") {
		if strings.TrimSpace(scope) == "" {
			return false
		}
	}
	return true
}

func validLabelColor(color string) bool {
	if len(color) != 7 || color[0] != '#' {
		return false
	}
	for _, c := range color[1:] {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// Apply mutates a transaction-local board. The caller must discard it on error.
func Apply(b *Board, c Command) error {
	if c.Proposal != nil {
		return invalid("proposal payload requires a proposal command")
	}
	if c.Revision != b.Workspace.Revision {
		return ErrConflict
	}
	if len(c.Reason) > 4000 {
		return invalid("rationale is too long")
	}
	if (c.Kind == "item.create" || c.Kind == "item.update") && c.Reason != "" {
		return invalid("item comments must be added separately")
	}
	switch c.Kind {
	case "integration.save", "link.attach", "link.detach":
		if err := applyIntegration(b, c); err != nil {
			return err
		}
	case "member.name":
		if b.Role != "admin" {
			return ErrForbidden
		}
		i := slices.IndexFunc(b.Members, func(m Member) bool { return m.Subject == c.Target })
		if i < 0 {
			return ErrNotFound
		}
		name := strings.TrimSpace(c.Name)
		if name == "" || len(name) > 120 {
			return invalid("member name must be 1–120 bytes")
		}
		b.Members[i].Name = name
	case "label.save", "label.delete":
		at := slices.IndexFunc(b.Labels, func(label Label) bool { return label.Name == c.Target })
		if c.Target != "" && at < 0 {
			return ErrNotFound
		}
		name := strings.TrimSpace(c.Name)
		if c.Kind == "label.delete" {
			if at < 0 {
				return ErrNotFound
			}
			b.Labels = slices.Delete(b.Labels, at, at+1)
		} else {
			if !validLabelName(name) {
				return invalid("label names must be 1–60 bytes and have nonempty scopes")
			}
			if slices.ContainsFunc(b.Labels, func(label Label) bool { return label.Name == name }) && name != c.Target {
				return invalid("label already exists")
			}
			color := DefaultLabelColor
			if at >= 0 {
				color = b.Labels[at].Color
			}
			if strings.TrimSpace(c.Color) != "" {
				color = strings.TrimSpace(c.Color)
			}
			if !validLabelColor(color) {
				return invalid("label color must be a six-digit hexadecimal color")
			}
			label := Label{Name: name, Color: color}
			if at < 0 {
				if len(b.Labels) >= 500 {
					return invalid("maximum 500 workspace labels")
				}
				b.Labels = append(b.Labels, label)
			} else {
				b.Labels[at] = label
			}
		}
		if c.Target != "" {
			for i := range b.Items {
				j := slices.Index(b.Items[i].Labels, c.Target)
				if j < 0 {
					continue
				}
				if c.Kind == "label.delete" {
					b.Items[i].Labels = slices.Delete(b.Items[i].Labels, j, j+1)
				} else {
					b.Items[i].Labels[j] = name
				}
				b.Items[i].Revision++
			}
		}
	case "item.create":
		if c.Item == nil || len(b.Items) >= MaxItems {
			return invalid("item required or workspace item limit reached")
		}
		item := *c.Item
		item.ID = NewID()
		item.Revision = 1
		item.Archived = false
		item.Rank = len(b.Items)
		item.Attachments = []Attachment{}
		b.Items = append(b.Items, item)
	case "item.update":
		if c.Item == nil {
			return invalid("item required")
		}
		i := itemIndex(b, c.Target)
		if i < 0 {
			return ErrNotFound
		}
		old := b.Items[i]
		if c.Item.Revision != old.Revision {
			return ErrConflict
		}
		item := *c.Item
		item.ID = old.ID
		item.Rank = old.Rank
		item.Revision = old.Revision + 1
		item.Archived = old.Archived
		item.Attachments = old.Attachments
		if old.Archived {
			return invalid("restore an archived item before editing")
		}
		b.Items[i] = item
	case "item.archive", "item.restore":
		i := itemIndex(b, c.Target)
		if i < 0 {
			return ErrNotFound
		}
		b.Items[i].Archived = c.Kind == "item.archive"
		b.Items[i].Revision++
		if b.Items[i].Archived {
			b.Items[i].SprintIDs = []string{}
		}
	case "item.move":
		i := itemIndex(b, c.Target)
		if i < 0 {
			return ErrNotFound
		}
		if b.Items[i].Archived {
			return invalid("archived item cannot move")
		}
		b.Items[i].ColumnID = c.Destination
		b.Items[i].Revision++
		if err := reorder(b, c.Target, c.Before); err != nil {
			return err
		}
	case "item.rank":
		if itemIndex(b, c.Target) < 0 {
			return ErrNotFound
		}
		if err := reorder(b, c.Target, c.Before); err != nil {
			return err
		}
	case "column.save":
		if c.Column == nil {
			return invalid("column required")
		}
		col := *c.Column
		if c.Target == "" {
			if len(b.Columns) >= 12 {
				return invalid("maximum 12 columns")
			}
			col.ID = NewID()
			col.Position = len(b.Columns)
			b.Columns = append(b.Columns, col)
		} else {
			i := slices.IndexFunc(b.Columns, func(v Column) bool { return v.ID == c.Target })
			if i < 0 {
				return ErrNotFound
			}
			col.ID = c.Target
			col.Position = b.Columns[i].Position
			b.Columns[i] = col
		}
	case "column.delete":
		if len(b.Columns) <= 1 {
			return invalid("keep at least one column")
		}
		i := slices.IndexFunc(b.Columns, func(v Column) bool { return v.ID == c.Target })
		if i < 0 {
			return ErrNotFound
		}
		if c.Destination == c.Target || !hasColumn(b, c.Destination) {
			return invalid("choose a destination column")
		}
		for j := range b.Items {
			if b.Items[j].ColumnID == c.Target {
				b.Items[j].ColumnID = c.Destination
				b.Items[j].Revision++
			}
		}
		b.Columns = slices.Delete(b.Columns, i, i+1)
	case "column.rank":
		i := slices.IndexFunc(b.Columns, func(v Column) bool { return v.ID == c.Target })
		if i < 0 {
			return ErrNotFound
		}
		col := b.Columns[i]
		b.Columns = slices.Delete(b.Columns, i, i+1)
		at := len(b.Columns)
		if c.Before != "" {
			at = slices.IndexFunc(b.Columns, func(v Column) bool { return v.ID == c.Before })
			if at < 0 {
				return invalid("invalid column position")
			}
		}
		b.Columns = slices.Insert(b.Columns, at, col)
	case "project.save":
		if c.Project == nil {
			return invalid("project required")
		}
		project := *c.Project
		project.WorkspaceID = b.Workspace.ID
		if c.Target == "" {
			if len(b.Projects) >= 100 {
				return invalid("maximum 100 projects per workspace")
			}
			project.ID = NewID()
			project.Revision = 1
			b.Projects = append(b.Projects, project)
		} else {
			i := slices.IndexFunc(b.Projects, func(v Project) bool { return v.ID == c.Target })
			if i < 0 {
				return ErrNotFound
			}
			if project.Revision != b.Projects[i].Revision {
				return ErrConflict
			}
			project.ID = c.Target
			project.Revision++
			b.Projects[i] = project
		}
	case "sprint.save":
		if c.Sprint == nil {
			return invalid("sprint required")
		}
		sp := *c.Sprint
		if c.Target == "" {
			if len(b.Sprints) >= 200 {
				return invalid("maximum 200 sprints")
			}
			sp.ID = NewID()
			sp.State = "planned"
			sp.Revision = 1
			b.Sprints = append(b.Sprints, sp)
		} else {
			i := sprintIndex(b, c.Target)
			if i < 0 {
				return ErrNotFound
			}
			old := b.Sprints[i]
			if old.State == "closed" {
				return invalid("closed sprint is immutable")
			}
			if sp.Revision != old.Revision {
				return ErrConflict
			}
			sp.ID = old.ID
			sp.State = old.State
			sp.Revision = old.Revision + 1
			b.Sprints[i] = sp
		}
	case "sprint.start":
		i := sprintIndex(b, c.Target)
		if i < 0 {
			return ErrNotFound
		}
		if b.Sprints[i].State != "planned" {
			return invalid("only a planned sprint can start")
		}
		b.Sprints[i].State = "active"
		b.Sprints[i].Revision++
	case "sprint.close":
		i := sprintIndex(b, c.Target)
		if i < 0 {
			return ErrNotFound
		}
		if b.Sprints[i].State != "active" {
			return invalid("only the active sprint can close")
		}
		if strings.TrimSpace(c.Reason) == "" {
			return invalid("closing rationale required")
		}
		if c.Destination != "" {
			j := sprintIndex(b, c.Destination)
			if j < 0 || b.Sprints[j].State == "closed" || c.Destination == c.Target {
				return invalid("carry-over destination must be another open sprint")
			}
		}
		for j := range b.Items {
			item := &b.Items[j]
			if !slices.Contains(item.SprintIDs, c.Target) {
				continue
			}
			b.ClosedScope = append(b.ClosedScope, Scope{c.Target, item.ID})
			item.SprintIDs = slices.DeleteFunc(item.SprintIDs, func(id string) bool { return id == c.Target })
			if category(b, item.ColumnID) != "done" && !item.Archived && c.Destination != "" && !slices.Contains(item.SprintIDs, c.Destination) {
				item.SprintIDs = append(item.SprintIDs, c.Destination)
			}
			item.Revision++
		}
		b.Sprints[i].State = "closed"
		b.Sprints[i].Revision++
	default:
		return invalid("unknown operation")
	}
	// Keep inline labels accepted by existing API clients and seed commands.
	if c.Kind == "item.create" || c.Kind == "item.update" {
		for _, name := range c.Item.Labels {
			if !slices.ContainsFunc(b.Labels, func(label Label) bool { return label.Name == name }) {
				if len(b.Labels) >= 500 {
					return invalid("maximum 500 workspace labels")
				}
				b.Labels = append(b.Labels, Label{Name: name, Color: DefaultLabelColor})
			}
		}
	}
	for i := range b.Columns {
		b.Columns[i].Position = i
	}
	for i := range b.Items {
		b.Items[i].Rank = i
	}
	if err := Validate(b); err != nil {
		return err
	}
	b.Workspace.Revision++
	return nil
}

func reorder(b *Board, id, before string) error {
	if id == before {
		return invalid("cannot order item before itself")
	}
	i := itemIndex(b, id)
	item := b.Items[i]
	b.Items = slices.Delete(b.Items, i, i+1)
	at := len(b.Items)
	if before != "" {
		at = itemIndex(b, before)
		if at < 0 {
			return invalid("unknown ordering anchor")
		}
	}
	b.Items = slices.Insert(b.Items, at, item)
	return nil
}
func itemIndex(b *Board, id string) int {
	return slices.IndexFunc(b.Items, func(v Item) bool { return v.ID == id })
}
func sprintIndex(b *Board, id string) int {
	return slices.IndexFunc(b.Sprints, func(v Sprint) bool { return v.ID == id })
}
func hasColumn(b *Board, id string) bool {
	return slices.ContainsFunc(b.Columns, func(v Column) bool { return v.ID == id })
}
func category(b *Board, id string) string {
	for _, c := range b.Columns {
		if c.ID == id {
			return c.Category
		}
	}
	return ""
}

func Validate(b *Board) error {
	labels := map[string]bool{}
	for _, label := range b.Labels {
		if !validLabelName(label.Name) || !validLabelColor(label.Color) || labels[label.Name] {
			return invalid("invalid or duplicate workspace label")
		}
		labels[label.Name] = true
	}
	for _, project := range b.Projects {
		if project.WorkspaceID != b.Workspace.ID || strings.TrimSpace(project.Name) == "" || len(project.Name) > 120 {
			return invalid("project needs a name and must belong to this workspace")
		}
	}
	counts := map[string]int{}
	graph := map[string][]string{}
	for _, c := range b.Columns {
		if strings.TrimSpace(c.Name) == "" || len(c.Name) > 80 || !slices.Contains([]string{"todo", "doing", "done"}, c.Category) || c.WIP < 0 || c.WIP > MaxItems {
			return invalid("column requires a name, lifecycle category, and non-negative WIP limit")
		}
	}
	for _, s := range b.Sprints {
		start, e1 := time.Parse("2006-01-02", s.Start)
		end, e2 := time.Parse("2006-01-02", s.End)
		if strings.TrimSpace(s.Name) == "" || len(s.Name) > 120 || strings.TrimSpace(s.Goal) == "" || len(s.Goal) > 4000 || e1 != nil || e2 != nil || end.Before(start) {
			return invalid("sprint needs name, goal, and valid ordered dates")
		}
	}
	for _, item := range b.Items {
		if strings.TrimSpace(item.Title) == "" || len(item.Title) > 240 || len(item.Description) > 16000 || !hasColumn(b, item.ColumnID) {
			return invalid("item requires title and valid column; content may exceed limits")
		}
		if item.Assignee != "" && !slices.ContainsFunc(b.Members, func(m Member) bool { return m.Subject == item.Assignee }) {
			return invalid("assignee must be a workspace member")
		}
		if item.ProjectID != "" && !slices.ContainsFunc(b.Projects, func(v Project) bool { return v.ID == item.ProjectID }) {
			return invalid("project must belong to this workspace")
		}
		sprints := map[string]bool{}
		for _, id := range item.SprintIDs {
			i := sprintIndex(b, id)
			if i < 0 || b.Sprints[i].State == "closed" || item.Archived || sprints[id] {
				return invalid("sprint memberships must be unique open sprints in this workspace")
			}
			sprints[id] = true
		}
		if len(item.Labels) > 20 || len(item.Dependencies) > 50 {
			return invalid("too many labels or dependencies")
		}
		seen := map[string]bool{}
		for _, label := range item.Labels {
			if !labels[label] || strings.TrimSpace(label) == "" || len(label) > 60 || seen[label] {
				return invalid("labels must be unique nonempty names up to 60 characters")
			}
			seen[label] = true
		}
		seen = map[string]bool{}
		for _, dep := range item.Dependencies {
			if dep == item.ID || itemIndex(b, dep) < 0 || seen[dep] {
				return invalid("invalid dependency")
			}
			seen[dep] = true
		}
		graph[item.ID] = item.Dependencies
		if !item.Archived {
			counts[item.ColumnID]++
		}
	}
	for _, c := range b.Columns {
		if c.WIP > 0 && counts[c.ID] > c.WIP {
			return invalid(fmt.Sprintf("%s WIP limit is %d", c.Name, c.WIP))
		}
	}
	visiting, done := map[string]bool{}, map[string]bool{}
	var visit func(string) bool
	visit = func(id string) bool {
		if visiting[id] {
			return false
		}
		if done[id] {
			return true
		}
		visiting[id] = true
		for _, dep := range graph[id] {
			if !visit(dep) {
				return false
			}
		}
		visiting[id] = false
		done[id] = true
		return true
	}
	for id := range graph {
		if !visit(id) {
			return invalid("dependency cycle")
		}
	}
	return nil
}
