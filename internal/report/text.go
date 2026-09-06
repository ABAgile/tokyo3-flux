package report

import (
	"fmt"
	"io"
	"strings"
)

// RenderText renders any supported report as a bounded, human-readable view.
// JSON remains the canonical machine-readable representation.
func RenderText(w io.Writer, value any) error {
	switch report := value.(type) {
	case StandupReport:
		return renderStandup(w, report)
	case *StandupReport:
		return renderStandup(w, *report)
	case SprintHealthReport:
		return renderSprintHealth(w, report)
	case *SprintHealthReport:
		return renderSprintHealth(w, *report)
	case RefinementReport:
		return renderRefinement(w, report)
	case *RefinementReport:
		return renderRefinement(w, *report)
	case PlanningReport:
		return renderPlanning(w, report)
	case *PlanningReport:
		return renderPlanning(w, *report)
	case BacklogReport:
		return renderBacklog(w, report)
	case *BacklogReport:
		return renderBacklog(w, *report)
	case RetrospectiveReport:
		return renderRetrospective(w, report)
	case *RetrospectiveReport:
		return renderRetrospective(w, *report)
	default:
		return fmt.Errorf("unsupported report type %T", value)
	}
}

func renderBase(w io.Writer, base Base) error {
	if err := writeLine(w, fmt.Sprintf("%s report", reportTitle(base.Kind))); err != nil {
		return err
	}
	if err := writeLine(w, fmt.Sprintf("Milestone: %s", valueOr(base.Milestone, "(unnamed current milestone)"))); err != nil {
		return err
	}
	if base.Goal != "" {
		if err := writeLine(w, "Goal: "+base.Goal); err != nil {
			return err
		}
	}
	if err := writeLine(w, fmt.Sprintf("As of: %s", base.AsOf.Format("2006-01-02T15:04:05Z07:00"))); err != nil {
		return err
	}
	if base.Coverage.WindowFrom != nil && base.Coverage.WindowUntil != nil {
		if err := writeLine(w, fmt.Sprintf("Window: %s to %s (end exclusive)", base.Coverage.WindowFrom.Format("2006-01-02T15:04:05Z07:00"), base.Coverage.WindowUntil.Format("2006-01-02T15:04:05Z07:00"))); err != nil {
			return err
		}
	}
	if err := writeLine(w, "Evidence:"); err != nil {
		return err
	}
	for _, source := range base.Coverage.Sources {
		stateName := "available"
		if !source.Available {
			stateName = "unavailable"
		}
		if err := writeLine(w, fmt.Sprintf("- %s: %s (%s)", source.Name, source.Provenance, stateName)); err != nil {
			return err
		}
	}
	if base.Truncated {
		if err := writeLine(w, "Output: bounded/truncated"); err != nil {
			return err
		}
	}
	return writeUncertainties(w, base.Coverage.Uncertainties)
}

func renderStandup(w io.Writer, report StandupReport) error {
	if err := renderBase(w, report.Base); err != nil {
		return err
	}
	if err := writeLine(w, fmt.Sprintf("Work: %d total", totalCounts(report.Counts))); err != nil {
		return err
	}
	if err := writeItemsSection(w, "Completed", report.Completed); err != nil {
		return err
	}
	if err := writeItemsSection(w, "In progress", report.InProgress); err != nil {
		return err
	}
	if err := writeItemsSection(w, "Needs attention", report.Attention); err != nil {
		return err
	}
	if err := writeItemsSection(w, "Other", report.Other); err != nil {
		return err
	}
	if err := writeChangesSection(w, "Recent Flux-observed changes", report.RecentChanges); err != nil {
		return err
	}
	if err := writeOverlay(w, report.HumanContext); err != nil {
		return err
	}
	return writeLimitations(w, report.Limitations)
}

func renderSprintHealth(w io.Writer, report SprintHealthReport) error {
	if err := renderBase(w, report.Base); err != nil {
		return err
	}
	if err := writeLine(w, fmt.Sprintf("Work: %d total", report.Total)); err != nil {
		return err
	}
	if err := writeLine(w, "Signal state: "+report.SignalState); err != nil {
		return err
	}
	if err := writeLine(w, fmt.Sprintf("Goal present: %t", report.GoalPresent)); err != nil {
		return err
	}
	if err := writeSignals(w, report.Signals); err != nil {
		return err
	}
	if err := writeItemsSection(w, "Attention", report.Attention); err != nil {
		return err
	}
	if report.Flow != nil {
		if err := writeLine(w, fmt.Sprintf("Observed flow: %d changes · %d started · %d completed · %d blocked · %d unblocked", report.Flow.Changes, report.Flow.Started, report.Flow.Completed, report.Flow.Blocked, report.Flow.Unblocked)); err != nil {
			return err
		}
	}
	if err := writeOverlay(w, report.HumanContext); err != nil {
		return err
	}
	return writeLimitations(w, report.Limitations)
}

func renderRefinement(w io.Writer, report RefinementReport) error {
	if err := renderBase(w, report.Base); err != nil {
		return err
	}
	if err := writeItemsSection(w, "Discussion candidates", report.Candidates); err != nil {
		return err
	}
	if err := writeSignals(w, report.Signals); err != nil {
		return err
	}
	if err := writeOverlay(w, report.HumanContext); err != nil {
		return err
	}
	return writeLimitations(w, report.Limitations)
}

func renderPlanning(w io.Writer, report PlanningReport) error {
	if err := renderBase(w, report.Base); err != nil {
		return err
	}
	if err := writeItemsSection(w, "Planning candidates (unstarted current-milestone items)", report.CandidateItems); err != nil {
		return err
	}
	if err := writeItemsSection(w, "In flight", report.InFlightItems); err != nil {
		return err
	}
	if err := writeItemsSection(w, "Risks", report.RiskItems); err != nil {
		return err
	}
	if err := writeChangesSection(w, "Recent Flux-observed changes", report.RecentChanges); err != nil {
		return err
	}
	if err := writeOverlay(w, report.HumanContext); err != nil {
		return err
	}
	return writeLimitations(w, report.Limitations)
}

func renderBacklog(w io.Writer, report BacklogReport) error {
	if err := renderBase(w, report.Base); err != nil {
		return err
	}
	if err := writeLine(w, fmt.Sprintf("Backlog scope: %d current-milestone items", report.Total)); err != nil {
		return err
	}
	if err := writeBuckets(w, report.Buckets); err != nil {
		return err
	}
	if err := writeItemsSection(w, "Unassigned", report.Unassigned); err != nil {
		return err
	}
	if err := writeItemsSection(w, "Attention", report.Attention); err != nil {
		return err
	}
	if err := writeItemsSection(w, "Items", report.Items); err != nil {
		return err
	}
	if err := writeChangesSection(w, "Recent Flux-observed changes", report.RecentChanges); err != nil {
		return err
	}
	if err := writeOverlay(w, report.HumanContext); err != nil {
		return err
	}
	return writeLimitations(w, report.Limitations)
}

func renderRetrospective(w io.Writer, report RetrospectiveReport) error {
	if err := renderBase(w, report.Base); err != nil {
		return err
	}
	if err := writeSignals(w, report.Signals); err != nil {
		return err
	}
	if report.Flow != nil {
		if err := writeLine(w, fmt.Sprintf("Observed flow: %d changes · %d added · %d started · %d completed · %d reopened", report.Flow.Changes, report.Flow.Added, report.Flow.Started, report.Flow.Completed, report.Flow.Reopened)); err != nil {
			return err
		}
	}
	if err := writeChangesSection(w, "Observed changes", report.ObservedChanges); err != nil {
		return err
	}
	if err := writeOverlay(w, report.HumanContext); err != nil {
		return err
	}
	return writeLimitations(w, report.Limitations)
}

func writeItemsSection(w io.Writer, title string, items []Item) error {
	if err := writeLine(w, fmt.Sprintf("%s (%d)", title, len(items))); err != nil {
		return err
	}
	if len(items) == 0 {
		return writeLine(w, "- none")
	}
	for _, item := range items {
		line := fmt.Sprintf("- %s · %s · %s", item.Status, item.ID, valueOr(item.Title, "(untitled)"))
		if item.Assignee != "" {
			line += " · " + item.Assignee
		} else {
			line += " · unassigned"
		}
		if err := writeLine(w, line); err != nil {
			return err
		}
		for _, signal := range item.Signals {
			if err := writeLine(w, "  signal: "+signal); err != nil {
				return err
			}
		}
	}
	return nil
}

func writeChangesSection(w io.Writer, title string, changes []ObservedChange) error {
	if err := writeLine(w, fmt.Sprintf("%s (%d)", title, len(changes))); err != nil {
		return err
	}
	if len(changes) == 0 {
		return writeLine(w, "- none observed in the selected window")
	}
	for _, change := range changes {
		label := valueOr(change.ItemID, change.EntityKey)
		line := fmt.Sprintf("- %s · %s · %s", change.Kind, label, change.ObservedAt.Format("2006-01-02T15:04:05Z07:00"))
		if err := writeLine(w, line); err != nil {
			return err
		}
	}
	return nil
}

func writeSignals(w io.Writer, signals []Signal) error {
	if err := writeLine(w, "Observable signals:"); err != nil {
		return err
	}
	if len(signals) == 0 {
		return writeLine(w, "- none observed")
	}
	for _, signal := range signals {
		if err := writeLine(w, fmt.Sprintf("- %s: %d (%s)", signal.Name, signal.Count, signal.Evidence)); err != nil {
			return err
		}
	}
	return nil
}

func writeBuckets(w io.Writer, buckets []BacklogBucket) error {
	if err := writeLine(w, "Status buckets:"); err != nil {
		return err
	}
	if len(buckets) == 0 {
		return writeLine(w, "- none")
	}
	for _, bucket := range buckets {
		if err := writeLine(w, fmt.Sprintf("- %s: %d", bucket.Status, bucket.Count)); err != nil {
			return err
		}
	}
	return nil
}

func writeOverlay(w io.Writer, overlay HumanContextOverlay) error {
	if err := writeLine(w, "Human-reported overlay (not GitLab evidence):"); err != nil {
		return err
	}
	if overlay.Provenance == "" {
		if err := writeLine(w, "- unavailable; no human context was joined"); err != nil {
			return err
		}
	} else if len(overlay.Entries) == 0 {
		if err := writeLine(w, "- none in the selected reporting window"); err != nil {
			return err
		}
	} else {
		for _, entry := range overlay.Entries {
			if err := writeLine(w, fmt.Sprintf("- %s · %s · %s", entry.Kind, entry.Category, entry.Statement)); err != nil {
				return err
			}
		}
	}
	return writeUncertainties(w, overlay.Uncertainties)
}

func writeLimitations(w io.Writer, values []string) error {
	if len(values) == 0 {
		return nil
	}
	if err := writeLine(w, "Limitations:"); err != nil {
		return err
	}
	for _, value := range values {
		if err := writeLine(w, "- "+value); err != nil {
			return err
		}
	}
	return nil
}

func writeUncertainties(w io.Writer, values []string) error {
	if len(values) == 0 {
		return nil
	}
	if err := writeLine(w, "Uncertainties:"); err != nil {
		return err
	}
	for _, value := range values {
		if err := writeLine(w, "- "+value); err != nil {
			return err
		}
	}
	return nil
}

func writeLine(w io.Writer, value string) error {
	_, err := fmt.Fprintln(w, value)
	return err
}

func reportTitle(kind Kind) string {
	switch kind {
	case KindSprintHealth:
		return "Sprint health"
	case KindRetrospective:
		return "Retrospective"
	case KindStandup:
		return "Standup"
	case KindRefinement:
		return "Refinement"
	case KindPlanning:
		return "Sprint planning"
	case KindBacklog:
		return "Backlog"
	default:
		return string(kind)
	}
}

func totalCounts(values map[string]int) int {
	total := 0
	for _, value := range values {
		total += value
	}
	return total
}

func valueOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
