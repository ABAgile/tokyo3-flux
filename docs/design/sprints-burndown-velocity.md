# Sprints, burn-down and delivery trend

- Sprint panels use a compact two-column header: sprint information spans the left, actions sit in the top-right, and metrics sit below the actions; an expanded burn-down spans the full panel width.
  At constrained widths, the header becomes a single column and metrics use a full-width wrapping row.
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
- Sprint panel has a safely rendered Markdown goal, dates, lifecycle and scope counts, explicit start/close/re-open/archive actions, and a read-only burn-down toggle.
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
