# Native planning UI

Applies to the native `/` planning application served by `flux serve`.
Native planning is the sole UI; the transitional cockpit is retired.

## Direction

A calm, compact planning workspace: left navigation, workspace heading, sprint goals
and scope summary, then a Kanban board or prioritized backlog. Native planning
state is primary; do not show invented GitLab or agent status. Display a clear
local-demo indicator when fixture authentication is enabled.

## Tokens

Use system sans-serif, 14px body, 12px metadata, 18px section headings, 28px page
headings; line height 1.5. Spacing scale: 4, 8, 12, 16, 24, 32px. Radius: 8px
controls, 12px cards/panels. Borders are 1px; focus ring is 3px with 2px offset.

Light colors: background #f4f6f1, panel #ffffff, inset #edf1eb, border #cfd8cc,
text #15241d, muted #53645a, accent #145a42, accent surface #dcefe4,
warning #80500a, danger #a53228. Dark colors: background #111713,
panel #1a241d, inset #222f26, border #3a4a3e, text #e7efe8, muted #aabaad,
accent #9be0b8, accent surface #1b3c2d, warning #e0aa55, danger #ffaca0.
Use these semantic tokens only. No external fonts or assets are required for the
base UI; optional GitLab avatar images use the configured instance.

## Components and interaction

- Sidebar 208px on desktop, top navigation below 900px. Main padding 32px on
  desktop, 16px below 900px. Board columns use a responsive grid, minimum 240px;
  wrap columns rather than causing page-level horizontal scroll.
- One shared board belongs to each workspace; projects classify items optionally.
  Project filtering sits beside Scope in the planning toolbar (All projects / No
  project / a project), never in the sidebar and never as a planning boundary. WIP
  counts the whole workspace column, regardless of filtering. Project management
  uses the existing dialog/controls, not a new component variant.
- Cards show project (or No project) and all open sprint memberships as badges.
  Item editor uses a project select and a labeled multiple-select for open sprints;
  closed-sprint membership is displayed read-only. Multiple active sprints are
  allowed. Closing one does not remove assignments to other open sprints.
- Cards have title, priority, assignee, labels, and blocked state. Cards and board
  columns use a restrained accent-border hover cue. Card ordering uses drag-and-drop;
  there are no separate up/down controls. The item editor’s labeled column select
  remains the keyboard movement mechanism. Cards are draggable from their body
  context, and columns are draggable from their headers, moving cards before/after
  cards or to a column’s end and reordering columns before/after another column.
  Drops use the same revision-checked commands; no optimistic rearrangement. Accent
  outlines mark drop targets, with top/bottom borders marking insertion. Filtering
  never changes project or sprint membership. Archived cards and viewers cannot drag.
- Workspace labels have create/rename/delete management (deletion confirms removal
  from all cards, including archived work). Item labels use a native labeled
  multiple-select, matching sprint selection. Names are plain text, at most 60 bytes.
- Assignee cards show an optional 24px circular GitLab avatar and display name when
  profile data is available from the configured read connector or current session.
  Assignee options and the Members dialog show display names, falling back to an
  admin-maintained name, the current session name, or an explicitly unnamed member
  identifier.
  Workspace admins can maintain missing names via Members; subjects remain the
  stored identity.
- Cards expose a GitLab links button and a separate compact observation summary
  per MR/pipeline (never a combined success indicator). Link dialogs use existing
  setup rows, badges, forms and live errors. Provider text, URLs and SHAs wrap within
  setup rows rather than causing horizontal scrolling. Display last-success time and
  explicitly mark unobserved, stale, unavailable, inaccessible, and not-found observations.
  A 404 means missing OR hidden, not proof of deletion. Old-head pipeline success
  is unknown for the current head. Provider errors preserve last-known data.
- Integration setup displays the operator-configured instance (never a free-form
  fetch URL). Admins approve numeric GitLab projects with explicit workspace-wide
  metadata visibility consent. Revoking approvals removes affected links/caches,
  not cards or audit. Members attach structured MR/pipeline coordinates and can
  manually refresh; viewers only read. Refresh never alters planning state.
  The dialog describes the configured background interval (or manual-only mode).
  Queued hints mark cached observations stale until fetched; outdated provider
  versions never replace newer cache entries. Board summaries reload cached
  observations every 15 seconds while idle, without moving cards or stealing
  focus. Pause these reads during drags, dialogs, pending writes and hidden tabs;
  changes to planning revisions require explicit Refresh. Dialogs are snapshots:
  reopen to see new background results, or request a manual observation refresh.
- Proposals in the workspace header opens a paginated review list. Members import
  versioned JSON as a draft (never an executable script). Show claimed provenance
  separately from authenticated importer/reviewer, rationale, native source IDs,
  revisions, exact field-by-field before/after values, and import deduplication
  counts. Plain-text wrapping `pre` blocks reuse existing panel tokens; no HTML
  or Markdown execution. Approval requires a separate explicit checkbox and
  review rationale. The consent checkbox precedes its label inline, using body
  typography and the 8px gap token; checkbox width is intrinsic. Reject is separate.
  Stale previews disable approval and retain the original document for copying/revision;
  never automatically rebase.
  Accepted reviews retain the exact historical diff, not a recomputed current diff.
  All controls use the existing dialog/form patterns; viewers cannot import/review-write.
- Sprint panel has goal, dates, lifecycle and scope counts, explicit start/close
  actions. Below 900px, the goal spans the full panel width above metrics/actions.
  Closing requires a rationale and an explicit additional carry-over choice (none, or
  another open sprint). Existing other sprint memberships are retained.
- Modal dialogs have a 640px maximum width and a 16px viewport margin;
  textareas start at 120px high.
- Use native labeled forms and modal dialogs with focus return. All controls have
  visible focus; errors and save/conflict status are announced with live regions.
- Never optimistic-save silently: disable submit during requests, retain form
  input on validation/conflict, offer explicit refresh, and show successful saves.
- Viewer mode disables write actions. Archive view and history preserve completed
  work. Loading, no-work, no-workspace, unavailable, and stale-revision states must
  be explicit. Render user content as text, not HTML.
- Theme toggle persists preference; initial theme follows system. Verify both
  themes at 1440px, 768px, and 390px and keyboard-only planning workflows.
