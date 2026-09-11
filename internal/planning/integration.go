package planning

import (
	"slices"
	"time"
)

// Integration is an explicit workspace-wide approval to expose engineering
// metadata to every workspace member. Credentials never enter planning records.
type Integration struct {
	Instance string  `json:"instance"`
	Projects []int64 `json:"projects"`
}
type LinkTarget struct {
	Project int64  `json:"project"`
	Kind    string `json:"kind"`
	Number  int64  `json:"number"`
}
type ExternalLink struct {
	RefreshPending bool   `json:"refresh_pending"`
	ID             string `json:"id"`
	LinkTarget
	Items       []string     `json:"items"`
	Observation *Observation `json:"observation"`
	LastSuccess *time.Time   `json:"last_success"`
	LastAttempt *time.Time   `json:"last_attempt"`
	Outcome     string       `json:"outcome"`
	NextRefresh *time.Time   `json:"next_refresh"`
}
type Pipeline struct {
	SourceUpdatedAt *time.Time `json:"source_updated_at,omitempty"`
	URL             string     `json:"url,omitempty"`
	ID              int64      `json:"id"`
	SHA             string     `json:"sha"`
	State           string     `json:"state"`
	ProviderState   string     `json:"provider_state"`
	CurrentHead     bool       `json:"current_head"`
}
type Observation struct {
	SourceUpdatedAt *time.Time `json:"source_updated_at,omitempty"`
	URL             string     `json:"url"`
	Title           string     `json:"title"`
	MRState         string     `json:"mr_state"`
	Draft           bool       `json:"draft"`
	Review          string     `json:"review"`
	HeadSHA         string     `json:"head_sha"`
	Pipeline        *Pipeline  `json:"pipeline"`
}

const MaxExternalID int64 = 9007199254740991 // JSON/JavaScript exact integer range.

func applyIntegration(b *Board, c Command) error {
	switch c.Kind {
	case "integration.save":
		if b.Role != "admin" {
			return ErrForbidden
		}
		if c.Integration == nil || len(c.Integration.Projects) > 100 {
			return invalid("at most 100 approved GitLab project IDs required")
		}
		seen := map[int64]bool{}
		for _, id := range c.Integration.Projects {
			if id <= 0 || id > MaxExternalID || seen[id] {
				return invalid("GitLab project IDs must be unique positive integers")
			}
			seen[id] = true
		}
		if len(c.Integration.Projects) > 0 && c.Integration.Instance == "" {
			return invalid("operator must configure the GitLab read connector first")
		}
		for _, link := range b.Links {
			if b.Integration.Instance != c.Integration.Instance || !seen[link.Project] {
				for _, id := range link.Items {
					if i := itemIndex(b, id); i >= 0 {
						b.Items[i].Revision++
					}
				}
			}
		}
		b.Links = slices.DeleteFunc(b.Links, func(link ExternalLink) bool {
			return b.Integration.Instance != c.Integration.Instance || !seen[link.Project]
		})
		b.Integration = *c.Integration
	case "link.attach":
		i := itemIndex(b, c.Target)
		if i < 0 {
			return ErrNotFound
		}
		if b.Items[i].Archived {
			return invalid("restore archived work before changing links")
		}
		if c.Link == nil || !slices.Contains(b.Integration.Projects, c.Link.Project) || b.Integration.Instance == "" {
			return invalid("GitLab project is not approved for this workspace")
		}
		if c.Link.Number <= 0 || c.Link.Number > MaxExternalID || c.Link.Kind != "mr" {
			return invalid("link needs kind mr and a positive IID")
		}
		count := 0
		for _, l := range b.Links {
			if slices.Contains(l.Items, c.Target) {
				count++
			}
		}
		if count >= 20 {
			return invalid("maximum 20 links per item")
		}
		j := slices.IndexFunc(b.Links, func(l ExternalLink) bool { return l.LinkTarget == *c.Link })
		if j < 0 {
			if len(b.Links) >= 200 {
				return invalid("maximum 200 registered links per workspace")
			}
			b.Links = append(b.Links, ExternalLink{ID: NewID(), LinkTarget: *c.Link, Items: []string{}, Outcome: "unobserved"})
			j = len(b.Links) - 1
		}
		if slices.Contains(b.Links[j].Items, c.Target) {
			return invalid("link already attached to this item")
		}
		b.Links[j].Items = append(b.Links[j].Items, c.Target)
		b.Items[i].Revision++
	case "link.detach":
		i := itemIndex(b, c.Target)
		if i < 0 {
			return ErrNotFound
		}
		if b.Items[i].Archived {
			return invalid("restore archived work before changing links")
		}
		j := slices.IndexFunc(b.Links, func(l ExternalLink) bool { return l.ID == c.Destination && slices.Contains(l.Items, c.Target) })
		if j < 0 {
			return ErrNotFound
		}
		b.Links[j].Items = slices.DeleteFunc(b.Links[j].Items, func(id string) bool { return id == c.Target })
		if len(b.Links[j].Items) == 0 {
			b.Links = slices.Delete(b.Links, j, j+1)
		}
		b.Items[i].Revision++
	}
	return nil
}
