package planning

import (
	"errors"
	"testing"
)

func TestIntegrationAuthorityAndLinks(t *testing.T) {
	b := testBoard()
	cfg := Integration{Instance: "https://gitlab.example", Projects: []int64{42}}
	if err := Apply(&b, Command{Kind: "integration.save", Integration: &cfg, Revision: 1}); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
	b.Role = "admin"
	mustApply(t, &b, Command{Kind: "integration.save", Integration: &cfg})
	b.Role = "member"
	target := LinkTarget{Project: 42, Kind: "mr", Number: 3}
	mustApply(t, &b, Command{Kind: "link.attach", Target: "a", Link: &target})
	mustApply(t, &b, Command{Kind: "link.attach", Target: "b", Link: &target})
	if len(b.Links) != 1 || len(b.Links[0].Items) != 2 {
		t.Fatal(b.Links)
	}
	if err := Apply(&b, Command{Kind: "link.attach", Target: "a", Link: &target, Revision: b.Workspace.Revision}); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	mustApply(t, &b, Command{Kind: "link.detach", Target: "a", Destination: b.Links[0].ID})
	if len(b.Links[0].Items) != 1 {
		t.Fatal(b.Links)
	}
	b.Role = "admin"
	cfg.Projects = []int64{}
	mustApply(t, &b, Command{Kind: "integration.save", Integration: &cfg})
	if len(b.Links) != 0 || len(b.Items) != 2 || b.Items[0].ColumnID != "ready" {
		t.Fatal(b)
	}
}
func TestInvalidExternalCoordinates(t *testing.T) {
	for _, target := range []LinkTarget{{Project: 41, Kind: "mr", Number: 1}, {Project: 42, Kind: "issue", Number: 1}, {Project: 42, Kind: "mr", Number: -1}, {Project: 42, Kind: "pipeline", Number: MaxExternalID + 1}} {
		b := testBoard()
		b.Integration = Integration{Instance: "https://gitlab.example", Projects: []int64{42}}
		if err := Apply(&b, Command{Kind: "link.attach", Target: "a", Link: &target, Revision: 1}); err == nil {
			t.Fatal(target)
		}
	}
	b := testBoard()
	b.Role = "admin"
	cfg := Integration{Instance: "https://gitlab.example", Projects: []int64{42, 42}}
	if err := Apply(&b, Command{Kind: "integration.save", Integration: &cfg, Revision: 1}); err == nil {
		t.Fatal("duplicate approval")
	}
}
