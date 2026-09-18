package store

import (
	"reflect"
	"strings"
	"testing"

	p "abagile.com/tokyo3/flux/internal/planning"
)

// linkDigestCoverage maps each mutable ExternalLink field the board reports to
// the SQL that must feed the digest. Identity fields carried by LinkTarget are
// fixed at creation and are covered by the link's presence in the aggregate.
var linkDigestCoverage = map[string]string{
	"id":              "e.id",
	"observation":     "e.observation",
	"last_success":    "e.last_success",
	"last_attempt":    "e.last_attempt",
	"outcome":         "e.outcome",
	"next_refresh":    "e.next_refresh",
	"refresh_pending": "e.dirty",
	"items":           "item_external_links",
	"project":         "",
	"kind":            "",
	"number":          "",
}

func linkJSONFields() []string {
	fields := []string{}
	var walk func(reflect.Type)
	walk = func(t reflect.Type) {
		for field := range t.Fields() {
			if field.Anonymous && field.Type.Kind() == reflect.Struct {
				walk(field.Type)
				continue
			}
			name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
			if name != "" && name != "-" {
				fields = append(fields, name)
			}
		}
	}
	walk(reflect.TypeFor[p.ExternalLink]())
	return fields
}

// A digest that silently stops tracking the board payload would freeze GitLab
// observations in every browser with no visible failure. Adding a link field
// must therefore be a deliberate decision about the digest.
func TestLinkObservationDigestCoversReportedFields(t *testing.T) {
	for _, field := range linkJSONFields() {
		fragment, known := linkDigestCoverage[field]
		if !known {
			t.Errorf("ExternalLink field %q is new: include it in linkObservationDigest or record why it cannot change", field)
			continue
		}
		if fragment == "" {
			continue
		}
		if !strings.Contains(linkObservationDigest, fragment) {
			t.Errorf("linkObservationDigest is missing %q for reported field %q", fragment, field)
		}
	}
}

// The digest must be workspace-scoped and stable, or one workspace's poll could
// observe another's links or flap between orderings.
func TestLinkObservationDigestIsScopedAndOrdered(t *testing.T) {
	if !strings.Contains(linkObservationDigest, "WHERE e.workspace_id=$1") {
		t.Error("digest must be scoped to one workspace")
	}
	if !strings.Contains(linkObservationDigest, "ORDER BY e.id") {
		t.Error("digest must aggregate in a stable order")
	}
	if !strings.Contains(linkObservationDigest, "ORDER BY i.item_id") {
		t.Error("digest must aggregate item links in a stable order")
	}
}
