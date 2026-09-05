package domain

import "time"

// ItemSummary pairs a work item with its derived status.
type ItemSummary struct {
	Item   WorkItem
	Status Status
}

// Summary is the compact status read model used by the CLI and future web UI.
type Summary struct {
	Items []ItemSummary
}

// Summarize derives the status of every work item in a sprint.
func Summarize(sprint Sprint, now time.Time, staleAfter time.Duration) Summary {
	items := make([]ItemSummary, 0, len(sprint.WorkItems))
	for _, item := range sprint.WorkItems {
		items = append(items, ItemSummary{
			Item:   item,
			Status: DeriveStatus(item, now, staleAfter),
		})
	}
	return Summary{Items: items}
}

// Count returns the number of work items with the requested status.
func (s Summary) Count(status Status) int {
	count := 0
	for _, item := range s.Items {
		if item.Status == status {
			count++
		}
	}
	return count
}

// Total returns the number of work items in the summary.
func (s Summary) Total() int {
	return len(s.Items)
}
