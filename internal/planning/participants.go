package planning

import "strconv"

// Participant roles, in the order a card presents them. The assignee is the
// planning owner, a reviewer comes from a cached merge-request observation, and
// a commenter is anyone who has written on the card.
const (
	RoleAssignee  = "assignee"
	RoleReviewer  = "reviewer"
	RoleCommenter = "commenter"
)

// MaxItemParticipants bounds what one card carries. A card shows a handful of
// avatars, so an item with a long comment thread must not turn the board read
// into a roster dump; the most recent commenters are the ones kept.
const MaxItemParticipants = 12

// Participant is a derived, read-only view of who is involved with a card. It
// is never accepted from a client, never part of a planning snapshot, and never
// a reason to bump an item revision: adding a comment or seeing a new reviewer
// changes who is shown without changing planning state.
//
// Name, Username and AvatarURL are carried only for identities the board cannot
// resolve on its own — GitLab reviewers who are not workspace members. Member
// participants are resolved against Board.Members by subject.
type Participant struct {
	ItemID    string   `json:"item_id"`
	Subject   string   `json:"subject"`
	Roles     []string `json:"roles"`
	Name      string   `json:"name,omitempty"`
	Username  string   `json:"username,omitempty"`
	AvatarURL string   `json:"avatar_url,omitempty"`
}

// Commenter is one card/author pair, already grouped by the store so a board
// read costs one query rather than one per card. Order is most recent first.
type Commenter struct {
	ItemID  string
	Subject string
}

// BuildParticipants aggregates the assignee, cached merge-request reviewers and
// comment authors of every item into one deduplicated, role-merged list. A
// person appears once per card, at the position of their strongest role, with
// every role they hold.
func BuildParticipants(items []Item, links []ExternalLink, commenters []Commenter) []Participant {
	indexes := make(map[string]map[string]int, len(items))
	out := []Participant{}
	add := func(itemID, subject, role string, identity Reviewer) {
		if itemID == "" || subject == "" {
			return
		}
		byItem, ok := indexes[itemID]
		if !ok {
			byItem = map[string]int{}
			indexes[itemID] = byItem
		}
		if index, seen := byItem[subject]; seen {
			for _, held := range out[index].Roles {
				if held == role {
					return
				}
			}
			out[index].Roles = append(out[index].Roles, role)
			return
		}
		if len(byItem) >= MaxItemParticipants {
			return
		}
		byItem[subject] = len(out)
		out = append(out, Participant{ItemID: itemID, Subject: subject, Roles: []string{role},
			Name: identity.Name, Username: identity.Username, AvatarURL: identity.AvatarURL})
	}
	live := make(map[string]bool, len(items))
	for _, item := range items {
		live[item.ID] = true
	}
	for _, item := range items {
		add(item.ID, item.Assignee, RoleAssignee, Reviewer{})
	}
	for _, link := range links {
		if link.Observation == nil {
			continue
		}
		for _, reviewer := range link.Observation.Reviewers {
			if reviewer.ID <= 0 || reviewer.ID > MaxExternalID {
				continue
			}
			subject := strconv.FormatInt(reviewer.ID, 10)
			for _, itemID := range link.Items {
				if live[itemID] {
					add(itemID, subject, RoleReviewer, reviewer)
				}
			}
		}
	}
	for _, commenter := range commenters {
		if live[commenter.ItemID] {
			add(commenter.ItemID, commenter.Subject, RoleCommenter, Reviewer{})
		}
	}
	return out
}
