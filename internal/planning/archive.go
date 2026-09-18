package planning

// ArchivePageLimit bounds one archive page. The archive is browsed, not
// planned against, so it is paged instead of shipped with the board.
const ArchivePageLimit = 50

// BrowserBoard drops archived items the browser cannot observe anyway, so the
// board payload tracks the live working set instead of the workspace's whole
// history.
//
// Archived items are still referenced by parts of the UI that read the board
// directly: closed sprint scope lists them, and dependency edges decide whether
// a live card renders as blocked. Those are retained; only inert archived items
// are withheld, and they remain reachable through the paged archive endpoint.
func BrowserBoard(b Board) Board {
	retained := make(map[string]bool, len(b.ClosedScope))
	for _, scope := range b.ClosedScope {
		retained[scope.ItemID] = true
	}
	// A retained archived item may itself depend on another archived item, so
	// the dependency closure is resolved to a fixed point.
	for changed := true; changed; {
		changed = false
		for _, item := range b.Items {
			if item.Archived && !retained[item.ID] {
				continue
			}
			for _, dep := range item.Dependencies {
				if !retained[dep] {
					retained[dep] = true
					changed = true
				}
			}
		}
	}
	items := make([]Item, 0, len(b.Items))
	for _, item := range b.Items {
		if item.Archived && !retained[item.ID] {
			continue
		}
		items = append(items, item)
	}
	b.Items = items
	return b
}
