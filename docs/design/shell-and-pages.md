# Shell and pages

- All page content lives inside `#content`, which has exactly two mounts.
  The persistent planning frame is a `page-stack` carrying the project lens, the sprint summaries, the planning filter slot and the board body, so Board, List and Archive read like every other page.
  `#page-root` holds one page root for every other view, named by `data-content-view`: the standard `page-stack` (Projects, Sprints, Members, Labels, History) or a page-specific composition (the first-run checklist).
  Only one mount is shown at a time; the frame is hidden rather than rebuilt, so filters and summaries keep their state, and a view that patches its own root in place keeps it across renders.
  `aria-busy` belongs to the body being rebuilt, never to the region holding the filters.
  The stack is a single column with one 16px gap, so every page spaces its sections alike.
  Pages are assembled from shared components rather than per-page markup: `section-head` (title with right-aligned actions), `help` guidance text, the `empty` state, the bordered `panel` surface shared by sprint, project-lens, delivery-trend, burn-down, workspace-gate, first-run and maintenance panels, the `metrics` row of value/caption pairs, the filter slot/bar/chips, and the maintenance list/row used by Projects, Members and Labels.
  Board/List, GitLab integration, delivery trend and History stay page-specific compositions built from those same parts.
- Sidebar 208px on desktop, top navigation below 900px.
  Main padding 32px on desktop, 16px below 900px.
  Navigation icons use a fixed 24px column so menu labels align.
  The workspace control has icon-only Create and Refresh actions beside its label.
  The sidebar footer is right-aligned.
  The theme control is an icon beside a single account cell; identity and Sign out appear on separate lines.
  Before a board is entered, a dedicated workspace gate asks users to choose among multiple memberships or create their first workspace; a single membership may open directly.
  Creation uses a labeled native form and makes the authenticated subject the initial administrator.
  The sidebar workspace selector remains available for switching after entry.
- Modal dialogs have a 640px maximum width and a 16px viewport margin; the item editor expands to 960px on wide screens.
  Dialog content always sits on an opaque panel surface over the dimmed backdrop, whether that content is a form or a plain panel.
  Textareas start at 120px high.
  The item editor's scrolling fields extend 16px into the dialog's right padding, so their content aligns with the header close button and footer actions while the scrollbar sits in that gutter.
- A workspace with no sprints and no work items shows a three-step setup path instead of empty columns: create a project, create and start a sprint, add the first work item.
  Steps may be done in any order, show a done state from current planning records, and link to the relevant view.
  Viewers never see it.
- Archive view and history preserve completed work.
  History entries identify the current workspace as `workspace name (id)` and render known member actors as `name (subject)`.
