package store

import p "abagile.com/tokyo3/flux/internal/planning"

// planningSnapshot keeps attachment metadata out of revisioned planning
// snapshots. Attachment lifecycle is stored and audited independently.
func planningSnapshot(board p.Board) p.Board {
	board.Items = append([]p.Item(nil), board.Items...)
	for index := range board.Items {
		board.Items[index].Attachments = nil
	}
	return board
}
