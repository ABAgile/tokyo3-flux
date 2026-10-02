# Native planning UI

Applies to the native `/` planning application served by `flux serve`.
Native planning is the sole UI; the transitional cockpit is retired.

## Direction

A calm, compact planning workspace: left navigation, workspace heading, sprint goals and scope summary, then a Kanban board with backlog as a scope option.
The home view defaults to Active sprints.
Sprint panels can reveal their burn-down chart without leaving the planning context.
Native planning state is primary; do not show invented GitLab or agent status.

## Tokens

Use system sans-serif, 14px body, 12px metadata, 18px section headings, 28px page headings; line height 1.5.
Spacing scale: 4, 8, 12, 16, 24, 32px.
Radius: 8px controls, 12px cards/panels.
Borders are 1px; focus ring is 3px with 2px offset.

Light colors: background #f4f6f1, panel #ffffff, inset #edf1eb, border #cfd8cc, text #15241d, muted #53645a, accent #145a42, accent surface #dcefe4, warning #80500a, danger #a53228.
Dark colors: background #111713, panel #1a241d, inset #222f26, border #3a4a3e, text #e7efe8, muted #aabaad, accent #9be0b8, accent surface #1b3c2d, warning #e0aa55, danger #ffaca0.
Label colors use a fixed 64-swatch palette: eight hue families with eight opaque, high-saturation swatches each.
Include #dcefe4, #145a42, and #ffcc00 for the default and common accent choices; use dark ink on light swatches and white on dark swatches.
Use semantic tokens for all other UI colors.
Motion is optional decoration: any transition, animation, or smooth scrolling must be neutralised under `prefers-reduced-motion: reduce`.
No external fonts or assets are required for the base UI; optional GitLab avatar images use the configured instance or a validated HTTPS Gravatar avatar URL.

## Components and interaction

## Global rules

- Use native labeled forms and modal dialogs with focus return.
  All controls have visible focus.
  Every form control carries a name when its value is submitted and a unique id otherwise, so a control rendered twice — the item editor and the detail pane — never collides; text-like controls opt out of autofill unless a real autocomplete token applies.
  The main region is a focus-management target for the skip link and for Escape, not a control, so it never paints a focus ring around the whole page.
  Errors and save/conflict status are announced with live regions.
  Transient progress and errors are separate surfaces: a polite status line carries progress and success and is written only when its text changes, so an unchanged board is never re-announced, while errors persist in their own assertive bar with an explicit Dismiss until dismissed or cleared by a later success.
  Workspace revision belongs to the non-live count, never to the status line.
  The persistent bars — stale planning revision, undo offer and error — stay separate live regions because their politeness and lifetimes differ and they can be shown together, but they share one `notice-bar` presentation with accent, warning and danger variants: 12px text, an inset surface, and one trailing action button.
  Inline progress and validation inside forms, comments, attachments and the workspace gate use one status line: polite while it reports progress, assertive while it carries an error, hidden while it says nothing.
  Inline write failures use the matching assertive error line, which is empty and hidden until a request fails and is cleared by the next attempt.
  Guidance, empty states, status and error lines are always the shared components; pages add a variant class rather than new markup.
  History keeps its own row list rather than reshaping the maintenance list, and Board, List, GitLab integration and the delivery trend stay page-specific compositions built from the shared panels, heads, metrics and filter parts.
  A skip link precedes the sidebar so keyboard users reach the main region without traversing navigation.
- Global keyboard shortcuts never fire while typing, while a dialog is open, or with Alt, Control or Meta held.
  Letter shortcuts match case-insensitively and accept Shift, so Caps Lock or a shifted key still activates them, and a modifier pressed on its own never cancels a pending chord.
  A chord announces the keys it is waiting for and stays open for 2.5 seconds.
  The shortcuts are: `/` focuses work search, `n` creates a work item, `r` refreshes, `g` followed by a view key navigates, and `?` opens a shortcut reference dialog.
  `Esc` leaves a focused page-level control and returns focus to the main region, so shortcuts are reachable again without using a pointer; inside a dialog, the detail pane, or an open selection menu it keeps its existing close behavior.
  Shortcut hints appear in the search placeholder and the reference dialog only.
- Never optimistic-save silently: disable submit during requests, retain form input on validation/conflict, offer explicit refresh, and show successful saves.
  Locally applied card placement and archive state are never silent either: the save is announced while it is in flight, and a failure rolls the board back rather than leaving an unsaved change on screen.
- Reversible single-command actions offer an explicit Undo.
  After archiving, restoring, moving, or reordering work, and after a bulk archive, a status bar below the notice names what happened and offers Undo for ten seconds.
  Undo issues the inverse revision-checked command, so a conflict is reported like any other write.
  Undo is offered only where a true inverse exists; irreversible maintenance such as deleting a label, column, or member keeps its existing confirmation dialog instead.
- Viewer mode disables write actions.
- A rendering failure stays contained: the planning content, the List detail pane and the open dialog each replace only themselves with the danger `notice-bar`, naming what could not be shown and offering Retry, while navigation and the rest of the page keep working.
  A failed dialog keeps its head with the close button, so it can always be dismissed.
  A failure in the rest of the shell — sidebar, heading or status bars — replaces the page with the same danger `notice-bar`, offering Reload.
  A failure outside rendering, such as a rejected background action or an exception in an event handler, appears in the error bar; cancelled work stays silent.
- Loading, no-work, no-workspace, unavailable, and stale-revision states must be explicit.
  Render user Markdown through the safe renderer; never execute raw HTML.
- Hints behave alike wherever they appear: a `?` beside a label for guidance, an `i` (bold italic serif, 16px in the same 20px circle) for details such as a work item's identity or a sprint's goal.
  A hint shows when the pointer rests on its button or on the hint for a moment, or when its button has keyboard focus, and it closes when the pointer leaves, on Escape, or when the page scrolls under a fixed hint.
  A mouse click does nothing, so a hint never stays on screen after the pointer has gone; only a device that cannot hover has no other way to open one, so there a tap toggles it and a tap elsewhere closes it.
- Theme toggle persists preference; initial theme follows system.
  Verify both themes at 1440px, 768px, and 390px and keyboard-only planning workflows.

## Design areas

Read this file first, then only the area files for the modules you change.
Module and CSS names are listed in [AGENTS.md](AGENTS.md).

| Area | Design doc | JS modules | CSS files |
|---|---|---|---|
| Shell, pages, dialogs, first run | [shell-and-pages](docs/design/shell-and-pages.md) | `app.js`, `app-shell`, `dialog`, `dialog-state`, `error-boundary`, `view-gate`, `view-archive`, `view-history` | `010`–`030`, `033-workspace-gate`, `037-archive-history`, `040-dialog`, `130-motion`, `180-shortcuts` |
| Filters and search | [filters](docs/design/filters.md) | `filters`, `planning-filters`, `url-state` | `100-filters` |
| Board and List | [board-and-list](docs/design/board-and-list.md) | `view-board`, `view-list`, `bulk`, `drag`, `autoscroll`, `card-menu`, `item-detail` | `032-board`, `036-summaries`, `038-card-menu`, `102-list`, `104-item-detail`, `106-list-responsive`, `120-bulk` |
| Cards, dates and participants | [cards-and-participants](docs/design/cards-and-participants.md) | `view-board`, `items`, `people`, `due-dates` | `032-board`, `200-participants`, `220-dates` |
| Attachments | [attachments](docs/design/attachments.md) | `item-attachments`, `tooltip` | `108-attachments` |
| Item editor, Markdown and comments | [item-editor](docs/design/item-editor.md) | `item-editor`, `item-detail`, `multi-select`, `markdown`, `item-comments` | `034-comments`, `035-markdown`, `050-forms`, `060-item-editor`, `220-dates` |
| GitLab links and observations | [gitlab-observations](docs/design/gitlab-observations.md) | `gitlab`, `gitlab-catalog`, `item-links`, `view-integration` | `090-gitlab`, `050-forms` |
| Sprints, burn-down and delivery trend | [sprints-burndown-velocity](docs/design/sprints-burndown-velocity.md) | `view-sprints`, `view-burndown`, `view-velocity` | `031-panels`, `070-burndown`, `160-velocity`, `210-sprint-goal` |
| Projects, members and labels | [maintenance](docs/design/maintenance.md) | `view-projects`, `view-members`, `view-labels`, `permissions` | `045-maintenance`, `110-action-icons` |
| Proposals | [proposals](docs/design/proposals.md) | `view-proposals` | `055-proposals`, `050-forms` |
| URL state and card sharing | [url-state-and-sharing](docs/design/url-state-and-sharing.md) | `url-state`, `item-editor` | `190-card-link` |
