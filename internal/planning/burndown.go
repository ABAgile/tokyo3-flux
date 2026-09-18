package planning

import (
	"slices"
	"time"
)

const MaxBurndownDays = 366

type BurndownPoint struct {
	Date      string `json:"date"`
	Scope     *int   `json:"scope"`
	Remaining *int   `json:"remaining"`
}

type Burndown struct {
	Version          int             `json:"version"`
	WorkspaceID      string          `json:"workspace_id"`
	Revision         int64           `json:"revision"`
	AsOf             time.Time       `json:"as_of"`
	Sprint           Sprint          `json:"sprint"`
	Project          string          `json:"project"`
	Assignee         string          `json:"assignee"`
	HistoryAvailable bool            `json:"history_available"`
	Warning          string          `json:"warning"`
	Points           []BurndownPoint `json:"points"`
}

// BurndownSnapshot is a native planning audit snapshot. Before is the state
// immediately before the recorded change; After is the state immediately
// after it. Provider observations are deliberately not part of this model.
type BurndownSnapshot struct {
	At     time.Time
	Before *Board
	After  *Board
}

// BuildBurndown derives daily remaining-work counts from native planning
// snapshots. Missing future history remains unavailable instead of being
// carried forward as if it were observed.
func BuildBurndown(b Board, sprintID, project, assignee string, snapshots []BurndownSnapshot, now time.Time) (Burndown, error) {
	if project == "all" {
		project = ""
	}
	if assignee == "all" {
		assignee = ""
	}
	if project != "" && project != "none" && !slices.ContainsFunc(b.Projects, func(v Project) bool { return v.ID == project }) {
		return Burndown{}, invalid("unknown project filter")
	}
	if assignee != "" && assignee != "none" && !slices.ContainsFunc(b.Members, func(v Member) bool { return v.Subject == assignee }) {
		return Burndown{}, invalid("unknown assignee filter")
	}
	at := slices.IndexFunc(b.Sprints, func(v Sprint) bool { return v.ID == sprintID })
	if at < 0 {
		return Burndown{}, ErrNotFound
	}
	sp := b.Sprints[at]
	start, startErr := time.ParseInLocation("2006-01-02", sp.Start, time.UTC)
	end, endErr := time.ParseInLocation("2006-01-02", sp.End, time.UTC)
	if startErr != nil || endErr != nil || end.Before(start) {
		return Burndown{}, invalid("sprint has invalid dates")
	}
	days := int(end.Sub(start)/(24*time.Hour)) + 1
	if days > MaxBurndownDays {
		return Burndown{}, invalid("sprint timeline is too long for a daily burn-down")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}

	out := Burndown{
		Version:     1,
		WorkspaceID: b.Workspace.ID,
		Revision:    b.Workspace.Revision,
		AsOf:        now,
		Sprint:      sp,
		Project:     project,
		Assignee:    assignee,
		Warning:     "Actual values use native planning snapshots. Future dates are blank; scope changes remain visible.",
		Points:      make([]BurndownPoint, days),
	}
	for i := range out.Points {
		out.Points[i].Date = start.AddDate(0, 0, i).Format("2006-01-02")
	}

	events := slices.Clone(snapshots)
	slices.SortStableFunc(events, func(a, z BurndownSnapshot) int {
		left, right := a.At.UTC(), z.At.UTC()
		if left.Before(right) {
			return -1
		}
		if left.After(right) {
			return 1
		}
		return 0
	})

	var state *Board
	var stateKnownAt time.Time
	for _, event := range events {
		if !event.At.UTC().Before(start) {
			break
		}
		if event.After != nil {
			state = event.After
			stateKnownAt = start
		} else if event.Before != nil {
			state = event.Before
			stateKnownAt = start
		}
	}
	if state == nil {
		// If the first known change is during the sprint, its snapshot can
		// establish history from that change onward, but not before it.
		for _, event := range events {
			when := event.At.UTC()
			if when.Before(start) {
				continue
			}
			if event.Before != nil {
				state = event.Before
			} else if event.After != nil {
				state = event.After
			}
			if state != nil {
				stateKnownAt = when
				break
			}
		}
	}
	out.HistoryAvailable = state != nil
	if !out.HistoryAvailable {
		out.Warning = "No native planning snapshots are available for this sprint yet. Actual progress will appear after the first planning change."
	} else if stateKnownAt.After(start) {
		out.Warning = "Recorded history begins on " + stateKnownAt.Format("2006-01-02") + "; earlier dates are unavailable. Future dates are blank; scope changes remain visible."
	}
	if now.Before(start) {
		out.Warning = "Sprint has not started; actual progress is unavailable until the sprint begins."
	}

	eventAt := 0
	for eventAt < len(events) && events[eventAt].At.UTC().Before(start) {
		eventAt++
	}
	for i := range out.Points {
		day := start.AddDate(0, 0, i)
		if day.After(now) {
			break
		}
		dayEnd := day.AddDate(0, 0, 1)
		for eventAt < len(events) {
			event := events[eventAt]
			when := event.At.UTC()
			if !when.Before(dayEnd) || when.After(now) {
				break
			}
			if event.After != nil {
				state = event.After
				stateKnownAt = when
			} else if event.Before != nil {
				state = event.Before
				if stateKnownAt.IsZero() {
					stateKnownAt = when
				}
			}
			eventAt++
		}
		if state == nil || !dayEnd.After(stateKnownAt) {
			continue
		}
		scope, remaining := burndownCounts(*state, sprintID, project, assignee)
		scopeValue, remainingValue := scope, remaining
		out.Points[i].Scope = &scopeValue
		out.Points[i].Remaining = &remainingValue
	}
	return out, nil
}

func burndownCounts(b Board, sprintID, project, assignee string) (scope, remaining int) {
	categories := make(map[string]string, len(b.Columns))
	for _, column := range b.Columns {
		categories[column.ID] = column.Category
	}
	closedScope := make(map[string]struct{}, len(b.ClosedScope))
	for _, closed := range b.ClosedScope {
		if closed.SprintID == sprintID {
			closedScope[closed.ItemID] = struct{}{}
		}
	}
	for _, item := range b.Items {
		_, closed := closedScope[item.ID]
		if item.Archived || (!slices.Contains(item.SprintIDs, sprintID) && !closed) || !matchesBurndownFilter(item, project, assignee) {
			continue
		}
		scope++
		if categories[item.ColumnID] != "done" {
			remaining++
		}
	}
	return scope, remaining
}

func matchesBurndownFilter(item Item, project, assignee string) bool {
	projects := ItemProjectIDs(item)
	if project == "none" {
		if len(projects) > 0 {
			return false
		}
	} else if project != "" && !slices.Contains(projects, project) {
		return false
	}
	if assignee == "none" {
		return item.Assignee == ""
	}
	return assignee == "" || item.Assignee == assignee
}
