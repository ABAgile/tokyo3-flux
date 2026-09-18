package store

import p "abagile.com/tokyo3/flux/internal/planning"

// planningSnapshot keeps attachment metadata out of revisioned planning
// snapshots. Attachment lifecycle is stored and audited independently.
//
// Item descriptions are elided as well. A description is the only unbounded
// field on the board (16000 bytes per item, 1000 items per workspace), so
// keeping it would make every audit row scale with the whole workspace's prose
// rather than with the change. Everything auditors and the burn-down reader
// need — identity, column, sprint scope, project, assignee, labels, archived
// state — is retained, and work_item_events still records the actor, action,
// target and rationale of every change.
func planningSnapshot(board p.Board) p.Board {
	board.Items = append([]p.Item(nil), board.Items...)
	for index := range board.Items {
		board.Items[index].Attachments = nil
		board.Items[index].Description = ""
	}
	return board
}
