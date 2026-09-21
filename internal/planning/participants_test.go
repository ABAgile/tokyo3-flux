package planning

import (
	"slices"
	"strconv"
	"testing"
)

// One card names each person once, carrying every role they hold, ordered
// assignee first, then reviewers, then the most recent commenters.
func TestBuildParticipantsMergesRoles(t *testing.T) {
	items := []Item{{ID: "a", Assignee: "42"}, {ID: "b"}}
	links := []ExternalLink{{
		ID: "l1", Items: []string{"a", "b", "gone"},
		Observation: &Observation{Reviewers: []Reviewer{
			{ID: 42, Name: "Alex Example", Username: "alex"},
			{ID: 77, Name: "Robin Reviewer", Username: "robin", AvatarURL: "https://gitlab.example/uploads/robin.png"},
			{ID: 0, Name: "Invalid"},
		}},
	}, {ID: "l2", Items: []string{"a"}}}
	commenters := []Commenter{{ItemID: "a", Subject: "99"}, {ItemID: "a", Subject: "42"}, {ItemID: "gone", Subject: "99"}}

	got := BuildParticipants(items, links, commenters)
	byItem := map[string][]Participant{}
	for _, participant := range got {
		byItem[participant.ItemID] = append(byItem[participant.ItemID], participant)
	}
	if len(byItem["gone"]) != 0 {
		t.Errorf("participants leaked for an item the board does not carry: %+v", byItem["gone"])
	}
	a := byItem["a"]
	if len(a) != 3 {
		t.Fatalf("card a participants = %+v, want three distinct people", a)
	}
	if a[0].Subject != "42" || !slices.Equal(a[0].Roles, []string{RoleAssignee, RoleReviewer, RoleCommenter}) {
		t.Errorf("assignee is not first with merged roles: %+v", a[0])
	}
	if a[0].Name != "" {
		t.Errorf("a member participant should resolve against the roster, not carry a provider name: %+v", a[0])
	}
	if a[1].Subject != "77" || !slices.Equal(a[1].Roles, []string{RoleReviewer}) || a[1].Username != "robin" {
		t.Errorf("reviewer identity is missing: %+v", a[1])
	}
	if a[2].Subject != "99" || !slices.Equal(a[2].Roles, []string{RoleCommenter}) {
		t.Errorf("commenter is not last: %+v", a[2])
	}
	b := byItem["b"]
	if len(b) != 2 || b[0].Subject != "42" || b[1].Subject != "77" {
		t.Errorf("unassigned card b = %+v, want both reviewers of its link", b)
	}
	if !slices.Equal(b[0].Roles, []string{RoleReviewer}) {
		t.Errorf("roles are per card, not global: %+v", b[0])
	}
}

// A long thread must not turn a board read into a roster dump.
func TestBuildParticipantsIsBounded(t *testing.T) {
	commenters := make([]Commenter, 0, MaxItemParticipants*3)
	for i := range MaxItemParticipants * 3 {
		commenters = append(commenters, Commenter{ItemID: "a", Subject: strconv.Itoa(1000 + i)})
	}
	got := BuildParticipants([]Item{{ID: "a", Assignee: "42"}}, nil, commenters)
	if len(got) != MaxItemParticipants {
		t.Fatalf("participants = %d, want the %d cap", len(got), MaxItemParticipants)
	}
	if got[0].Subject != "42" {
		t.Errorf("the cap dropped the assignee: %+v", got[0])
	}
}

// Withholding an archived card must withhold its people too.
func TestBrowserBoardDropsParticipantsOfWithheldItems(t *testing.T) {
	b := Board{
		Items:        []Item{{ID: "live"}, {ID: "old", Archived: true}},
		Participants: []Participant{{ItemID: "live", Subject: "42", Roles: []string{RoleAssignee}}, {ItemID: "old", Subject: "99", Roles: []string{RoleCommenter}}},
	}
	got := BrowserBoard(b).Participants
	if len(got) != 1 || got[0].ItemID != "live" {
		t.Fatalf("participants = %+v, want only the live card", got)
	}
}
