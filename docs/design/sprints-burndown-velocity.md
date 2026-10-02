# Sprints, burn-down and delivery trend

- A sprint panel is a header row so the board stays the focus: the sprint kind and dates over its name, with the scope counts and the action icons on the right.
  The counts and actions wrap beneath the name only when the width runs out, and at 480px and below the actions take their own row as labelled buttons.
  The whole panel expands to its burn-down chart and folds back: a click on the name, on any part of the panel that is not a control, or on the chart itself toggles it, while buttons, links, the daily-values disclosure and its table do not.
  The name is the keyboard control, a button with a chevron and `aria-expanded`; panels start folded, and a sprint stays expanded while the workspace is open.
- The sprint goal is stated according to the panel's state.
  Folded, it is an `i` hint beside the name that shows the safe Markdown goal, and for a closed sprint the note about preserved scope; like every hint it opens on hover or keyboard focus and ignores a click, and its box stays open while the pointer is on it so links in the goal work.
  Expanded, the `i` is replaced by the goal itself under the title, with a GOAL label and an accent rule, because it is what the team is aiming for; the burn-down follows it.
- Multiple active sprints are allowed.
  Closing one does not remove assignments to other open sprints.
- The Sprints page uses the same page layout as Projects: the read-only Delivery trend section first, then the sprint section whose heading is followed by the planning filter bar and its chips, then the sprint list.
  It keeps Project and Assignee in that bar, followed by Search.
  Those filters select which sprints are listed, not only what their metrics count: a sprint appears when its scope still holds work matching every active filter, and the delivery trend covers the same sprints.
  With no work filter active no sprint is excluded, so an empty sprint stays visible and plannable.
  Search case-insensitively matches sprint names and goals and shows a visible sprint count.
- The Sprints page opens with a read-only Delivery trend section above the sprint section: committed and completed counts for the last eight closed sprints as a grouped bar chart, last/average/best completed metrics, a legend, and an accessible sprint-values table behind a native disclosure.
  It is derived live from preserved closed-sprint scope and each card's current column, so it states that completion is not the state recorded at closure.
  Planning toolbar Project and Assignee filters apply to it.
  With no closed sprint it says so rather than plotting an empty chart.
  Archived sprints are excluded from this live trend; their immutable closure summaries appear in a paginated history section below planning.
- Sprint panel has a safely rendered Markdown goal (in its hint), dates, lifecycle and scope counts, and explicit view-scope, edit, start/close/re-open/archive actions; the burn-down is the panel's own expansion, not a separate action.
  Goal headings scale from 14–18px so they remain subordinate to the sprint title; tables and code blocks scroll within the goal, and long links wrap.
  Goals longer than about eight lines are clipped behind a native Show more/Show less button; expansion has no animation.
  Re-opening a closed sprint restores its preserved scope as an active sprint while retaining any other open sprint assignments.
  The chart expands inside the same panel on the Kanban board and Sprint planning displays; collapse state does not alter planning data.
  Archiving is available only for a closed sprint, removes it from working sprint selectors, never deletes its cards, and leaves its closure snapshot and metadata read-only in sprint history.
  Selecting a closed sprint in the board Scope filter shows its corresponding read-only panel.
  At constrained content widths, the goal spans the full panel width above metrics/actions, which stack without overlap; below 900px the compact panel spacing is used.
  Closing requires a rationale and an explicit additional carry-over choice (none, or another open sprint).
  Existing other sprint memberships are retained.
- Burn-down plots remaining native work-item count by day, a dashed ideal line, and the recorded scope so one chart can describe a sprint, project, member, or their intersection.
  Project and Assignee controls in the planning filter bar apply to an expanded chart.
  Project and assignee filters are evaluated against each dated native planning snapshot; scope changes remain visible.
  Future dates and periods without recorded history are blank rather than invented.
  The chart uses existing semantic tokens, places the active filter condition beside a compact figure on wide screens, and has an accessible horizontal daily-values table behind a native disclosure.
  It wraps below 900px without page-level horizontal scrolling.
  Sprint counts are small, so the figure is drawn at its real width and a fixed 112px height with three gridlines, however wide the panel.
  The text column (heading, filter condition, counts) stays beside the chart down to 560px, below which the chart goes under it; the recorded-history note runs under the whole row.
