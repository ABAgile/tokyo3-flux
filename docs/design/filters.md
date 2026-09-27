# Filters and search

- Every filtered page uses the same `filter-bar` component: a horizontal line of labeled native selects and an optional search box on the left, and a right-aligned `filter-bar-count` for the visible record count.
  It is the only filter container; there is no separate toolbar component.
  Board and Archive host it in the planning frame's slot, above the board body and below the summaries.
  Pages that own a section layout — Projects and Sprints — host it inside their own section, immediately below the section heading it filters.
  The shared planning filter bar is rendered only in its active host, never duplicated; its state remains shared across views.
  Maintenance views without work filters hide it.
- One shared board belongs to each workspace; projects classify items optionally, and a work item may belong to multiple projects.
  Project, assignee and label filters sit beside Scope in the planning filter bar (including unassigned and named assignees), never in the sidebar and never as a planning boundary.
  Each of those three filters accepts several values at once.
  The native select adds one value and returns to its All entry, so it reads as an add-a-filter control; the active values appear as removable chips in a row directly above the planning content, with a Clear filters action once more than one is active.
  Values within a filter combine as OR; separate filters combine as AND.
  The empty choice (No project, Unassigned, No labels) means "no association" and is mutually exclusive with concrete values.
  The project lens, the new-item project default and the burn-down request apply only when exactly one concrete value is selected; a wider selection states that the chart shows all.
  Work search is debounced so a long board is filtered once per pause, and Enter applies the pending query immediately.
- Scope lists Active sprints, Backlog, and All open work in that order.
- Project scope defaults to List; changing the Project filter on Kanban preserves the current presentation.
