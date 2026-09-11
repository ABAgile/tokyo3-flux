package planning

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"time"
)

// ProposalDocument contains data, never executable agent instructions. Provenance
// is a claim supplied by its author; the authenticated importer is recorded separately.
type ProposalDocument struct {
	Version     int          `json:"version"`
	WorkspaceID string       `json:"workspace_id"`
	Revision    int64        `json:"revision"`
	Title       string       `json:"title"`
	Rationale   string       `json:"rationale"`
	Provenance  string       `json:"provenance"`
	Evidence    []Evidence   `json:"evidence"`
	Operations  []Operation  `json:"operations"`
	Imports     []ImportItem `json:"imports,omitempty"`
}
type Evidence struct {
	Kind       string     `json:"kind"`
	ID         string     `json:"id"`
	Revision   int64      `json:"revision,omitempty"`
	ObservedAt *time.Time `json:"observed_at,omitempty"`
	Outcome    string     `json:"outcome,omitempty"`
}

// Restrict proposals to existing-item edits/moves/ranks. Item updates include the
// complete desired item and its expected revision, including explicit sprint scope.
type Operation struct {
	Kind             string `json:"kind"`
	Target           string `json:"target"`
	ExpectedRevision int64  `json:"expected_revision"`
	Item             *Item  `json:"item,omitempty"`
	Destination      string `json:"destination,omitempty"`
	Before           string `json:"before,omitempty"`
}
type ImportItem struct {
	Source string `json:"source"` // canonical instance / numeric project / issue IID
	Item   Item   `json:"item"`
}
type ProposalSummary struct {
	ID         string `json:"id"`
	Sequence   int64  `json:"sequence"`
	Title      string `json:"title"`
	State      string `json:"state"`
	ImportedBy string `json:"imported_by"`
	Revision   int64  `json:"revision"`
}
type Proposal struct {
	ID           string           `json:"id"`
	Sequence     int64            `json:"sequence"`
	State        string           `json:"state"`
	ImportedBy   string           `json:"imported_by"`
	ReviewedBy   string           `json:"reviewed_by"`
	ReviewReason string           `json:"review_reason"`
	CreatedAt    time.Time        `json:"created_at"`
	Document     ProposalDocument `json:"document"`
	NativeIDs    []string         `json:"-"`
}
type FieldChange struct {
	Before any `json:"before"`
	After  any `json:"after"`
}
type ItemDiff struct {
	ID     string                 `json:"id"`
	Fields map[string]FieldChange `json:"fields"`
}
type ProposalPreview struct {
	WorkspaceChanges map[string]FieldChange `json:"workspace_changes"`
	Problem          string                 `json:"problem"`
	Proposal         Proposal               `json:"proposal"`
	Digest           string                 `json:"digest"`
	Changes          []ItemDiff             `json:"changes"`
	Skipped          map[string]string      `json:"skipped"`
	Created          int                    `json:"created"`
	Revision         int64                  `json:"revision"`
}

func sameInstant(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}
func (d ProposalDocument) Validate(b Board) error {
	if d.Version != 1 || d.WorkspaceID != b.Workspace.ID || strings.TrimSpace(d.Title) == "" || len(d.Title) > 120 || strings.TrimSpace(d.Rationale) == "" || len(d.Rationale) > 4000 || strings.TrimSpace(d.Provenance) == "" || len(d.Provenance) > 500 || len(d.Evidence) > 100 || len(d.Imports)+len(d.Operations) == 0 || len(d.Imports)+len(d.Operations) > 50 {
		return invalid("invalid proposal envelope; version 1 and 1–50 operations/imports required")
	}
	if len(d.Operations) > 0 && len(d.Evidence) == 0 {
		return invalid("agent proposals require workspace evidence")
	}
	if d.Revision != b.Workspace.Revision {
		return ErrConflict
	}
	if len(d.Imports) > 0 && len(d.Operations) > 0 {
		return invalid("imports and agent operations must be separate proposals")
	}
	seen := map[string]bool{}
	for _, op := range d.Operations {
		if seen[op.Target] {
			return invalid("one operation per target per proposal")
		}
		seen[op.Target] = true
		i := itemIndex(&b, op.Target)
		if i < 0 {
			return ErrNotFound
		}
		if b.Items[i].Archived {
			return invalid("restore archived work before proposing edits")
		}
		if b.Items[i].Revision != op.ExpectedRevision {
			return ErrConflict
		}
		switch op.Kind {
		case "item.update":
			if op.Item == nil || op.Item.Revision != op.ExpectedRevision || op.Item.ID != op.Target || op.Destination != "" || op.Before != "" {
				return invalid("invalid item update")
			}
		case "item.move":
			if op.Item != nil || op.Destination == "" {
				return invalid("invalid item move")
			}
		case "item.rank":
			if op.Item != nil || op.Destination != "" {
				return invalid("invalid item rank")
			}
		default:
			return invalid("proposal operation is not allowed")
		}
	}
	for _, e := range d.Evidence {
		switch e.Kind {
		case "item":
			i := itemIndex(&b, e.ID)
			if i < 0 {
				return ErrNotFound
			}
			if e.Revision != b.Items[i].Revision {
				return ErrConflict
			}
		case "link":
			i := slices.IndexFunc(b.Links, func(l ExternalLink) bool { return l.ID == e.ID })
			if i < 0 {
				return ErrNotFound
			}
			l := b.Links[i]
			if !sameInstant(e.ObservedAt, l.LastSuccess) || e.Outcome != l.Outcome || l.RefreshPending {
				return ErrConflict
			}
		default:
			return invalid("evidence must reference workspace items or links")
		}
	}
	seen = map[string]bool{}
	for _, entry := range d.Imports {
		if !ValidImportSource(entry.Source) || seen[entry.Source] || entry.Item.ID != "" || entry.Item.Revision != 0 || entry.Item.Archived || len(entry.Item.Dependencies) > 0 {
			return invalid("invalid or duplicate import source; imports cannot invent native identities/dependencies")
		}
		seen[entry.Source] = true
	}
	return nil
}

// PreviewProposal mutates only its private deep copy. Stable server-generated IDs
// make the preview identical to acceptance; callers supply existing import receipts.
func PreviewProposal(b Board, proposal Proposal, skipped map[string]string) (Board, ProposalPreview, error) {
	preview := ProposalPreview{Proposal: proposal, Changes: []ItemDiff{}, Skipped: skipped, Revision: b.Workspace.Revision}
	if err := proposal.Document.Validate(b); err != nil {
		return Board{}, preview, err
	}
	raw, _ := json.Marshal(b)
	var after Board
	if err := json.Unmarshal(raw, &after); err != nil {
		return Board{}, preview, err
	}
	for _, op := range proposal.Document.Operations {
		reason := proposal.Document.Rationale
		if op.Kind == "item.create" || op.Kind == "item.update" {
			reason = ""
		}
		c := Command{Kind: op.Kind, Revision: after.Workspace.Revision, Target: op.Target, Item: op.Item, Destination: op.Destination, Before: op.Before, Reason: reason}
		if err := Apply(&after, c); err != nil {
			return Board{}, preview, err
		}
	}
	if len(proposal.NativeIDs) != len(proposal.Document.Imports) {
		return Board{}, preview, ErrInvalid
	}
	for i, entry := range proposal.Document.Imports {
		if _, ok := skipped[entry.Source]; ok {
			continue
		}
		if err := Apply(&after, Command{Kind: "item.create", Revision: after.Workspace.Revision, Item: &entry.Item}); err != nil {
			return Board{}, preview, err
		}
		after.Items[len(after.Items)-1].ID = proposal.NativeIDs[i]
		preview.Created++
	}
	old := map[string]Item{}
	for _, it := range b.Items {
		old[it.ID] = it
	}
	for _, it := range after.Items {
		before, exists := old[it.ID]
		if exists && reflect.DeepEqual(before, it) {
			continue
		}
		diff := ItemDiff{ID: it.ID, Fields: map[string]FieldChange{}}
		a, z := map[string]any{}, map[string]any{}
		raw, _ = json.Marshal(it)
		_ = json.Unmarshal(raw, &z)
		if exists {
			raw, _ = json.Marshal(before)
			_ = json.Unmarshal(raw, &a)
		}
		for field, v := range z {
			if !reflect.DeepEqual(a[field], v) {
				diff.Fields[field] = FieldChange{Before: a[field], After: v}
			}
		}
		preview.Changes = append(preview.Changes, diff)
	}
	preview.WorkspaceChanges = map[string]FieldChange{}
	if b.Workspace.Revision != after.Workspace.Revision {
		preview.WorkspaceChanges["revision"] = FieldChange{Before: b.Workspace.Revision, After: after.Workspace.Revision}
	}
	if !reflect.DeepEqual(b.Labels, after.Labels) {
		preview.WorkspaceChanges["labels"] = FieldChange{Before: b.Labels, After: after.Labels}
	}
	preview.Revision = after.Workspace.Revision
	return after, preview, nil
}
