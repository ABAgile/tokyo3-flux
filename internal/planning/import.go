package planning

import (
	"fmt"
	"net/url"
	"path"
	"strconv"
	"strings"
)

// Snapshot is only a one-time import DTO. Its states and identities have no
// native planning authority. Unknown legacy provider metadata is intentionally ignored.
type Snapshot struct {
	Sprint struct {
		Name      string         `json:"name"`
		WorkItems []SnapshotItem `json:"work_items"`
	} `json:"sprint"`
}
type SnapshotItem struct {
	ID        string `json:"id"`
	ProjectID int64  `json:"project_id"`
	Title     string `json:"title"`
}
type ImportMapping struct {
	Instance string          `json:"instance"`
	Records  []RecordMapping `json:"records"`
}
type RecordMapping struct {
	SnapshotID      string `json:"snapshot_id"`
	GitLabProjectID int64  `json:"gitlab_project_id"`
	IssueIID        int64  `json:"issue_iid"`
	Skip            bool   `json:"skip"`
	Reason          string `json:"reason"`
	// A complete mapped native item: title is copied from the snapshot; all other
	// planning values are human choices. Empty assignee/project/sprints/labels mean none.
	Item Item `json:"item"`
}
type ImportReport struct {
	AlreadyImported int               `json:"already_imported"`
	WouldCreate     int               `json:"would_create"`
	Document        *ProposalDocument `json:"document"`
	Unresolved      []string          `json:"unresolved"`
	Skipped         []string          `json:"skipped"`
	Matched         int               `json:"matched"`
}

func ValidImportSource(source string) bool {
	u, err := url.Parse(source)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || u.Host != strings.ToLower(u.Host) || u.Port() == "443" || strings.HasSuffix(u.Hostname(), ".") || u.String() != source || path.Clean(u.Path)+"/" != u.Path {
		return false
	}
	parts := strings.Split(u.Path, "/")
	if len(parts) < 6 {
		return false
	}
	n := len(parts)
	if parts[n-5] != "projects" || parts[n-3] != "issues" || parts[n-1] != "" {
		return false
	}
	for _, raw := range []string{parts[n-4], parts[n-2]} {
		v, e := strconv.ParseInt(raw, 10, 64)
		if e != nil || v <= 0 || v > MaxExternalID || strconv.FormatInt(v, 10) != raw {
			return false
		}
	}
	return len(source) <= 1000
}

// CompileImport is a dry run: no DB mutation or GitLab calls. No mapping means
// unresolved, not guessed; source coordinates must be explicitly supplied.
func CompileImport(snapshot Snapshot, mapping ImportMapping, wid string, revision int64) ImportReport {
	report := ImportReport{Unresolved: []string{}, Skipped: []string{}}
	d := ProposalDocument{Version: 1, WorkspaceID: wid, Revision: revision, Title: "Import planning snapshot", Rationale: "Review every explicit mapping and retained source before accepting.", Provenance: "Operator-supplied snapshot and mapping (unverified source)", Evidence: []Evidence{}, Operations: []Operation{}, Imports: []ImportItem{}}
	if len(snapshot.Sprint.WorkItems) == 0 || len(snapshot.Sprint.WorkItems) > 50 || len(mapping.Records) > 50 {
		report.Unresolved = append(report.Unresolved, "A batch requires 1–50 snapshot records and at most 50 mappings")
		return report
	}
	records := map[string]RecordMapping{}
	for _, m := range mapping.Records {
		if _, ok := records[m.SnapshotID]; ok {
			report.Unresolved = append(report.Unresolved, "Duplicate mapping: "+m.SnapshotID)
		}
		records[m.SnapshotID] = m
	}
	seen := map[string]bool{}
	sources := map[string]bool{}
	for _, it := range snapshot.Sprint.WorkItems {
		if it.ID == "" || seen[it.ID] {
			report.Unresolved = append(report.Unresolved, "Empty or ambiguous snapshot ID: "+it.ID)
			continue
		}
		seen[it.ID] = true
		m, ok := records[it.ID]
		if !ok {
			report.Unresolved = append(report.Unresolved, "Mapping required: "+it.ID)
			continue
		}
		if m.Skip {
			if strings.TrimSpace(m.Reason) == "" {
				report.Unresolved = append(report.Unresolved, "Skip rationale required: "+it.ID)
			} else {
				report.Skipped = append(report.Skipped, it.ID+": "+m.Reason)
			}
			continue
		}
		source := fmt.Sprintf("%s/projects/%d/issues/%d/", strings.TrimRight(mapping.Instance, "/"), m.GitLabProjectID, m.IssueIID)
		if !ValidImportSource(source) || sources[source] || (it.ProjectID != 0 && it.ProjectID != m.GitLabProjectID) || m.Item.ColumnID == "" {
			report.Unresolved = append(report.Unresolved, "Unresolved source identity or column: "+it.ID)
			continue
		}
		sources[source] = true
		m.Item.Title = it.Title
		d.Imports = append(d.Imports, ImportItem{Source: source, Item: m.Item})
		report.Matched++
	}
	for id := range records {
		if !seen[id] {
			report.Unresolved = append(report.Unresolved, "Mapping not in snapshot: "+id)
		}
	}
	if len(report.Unresolved) == 0 && len(d.Imports) > 0 {
		report.Document = &d
	}
	return report
}
