# Native planning UI

Applies to the native `/` planning application served by `flux serve`. Native planning is the sole
UI; the transitional cockpit is retired.

## Direction

A calm, compact planning workspace: left navigation, workspace heading, sprint goals and scope
summary, then a Kanban board with backlog as a scope option. The home view defaults to Active
sprints. Sprint panels can reveal their burn-down chart without leaving the planning context. Native
planning state is primary; do not show invented GitLab or agent status.

## Tokens

Use system sans-serif, 14px body, 12px metadata, 18px section headings, 28px page headings; line
height 1.5. Spacing scale: 4, 8, 12, 16, 24, 32px. Radius: 8px controls, 12px cards/panels. Borders
are 1px; focus ring is 3px with 2px offset.

Light colors: background #f4f6f1, panel #ffffff, inset #edf1eb, border #cfd8cc, text #15241d, muted
#53645a, accent #145a42, accent surface #dcefe4, warning #80500a, danger #a53228. Dark colors:
background #111713, panel #1a241d, inset #222f26, border #3a4a3e, text #e7efe8, muted #aabaad,
accent #9be0b8, accent surface #1b3c2d, warning #e0aa55, danger #ffaca0. Label colors use a fixed
64-swatch palette: eight hue families with eight opaque, high-saturation swatches each. Include
#dcefe4, #145a42, and #ffcc00 for the default and common accent choices; use dark ink on light
swatches and white on dark swatches. Use semantic tokens for all other UI colors. No external fonts
or assets are required for the base UI; optional GitLab avatar images use the configured instance or
a validated HTTPS Gravatar avatar URL.

## Components and interaction

- Sidebar 208px on desktop, top navigation below 900px. Main padding 32px on desktop, 16px below
  900px. Navigation icons use a fixed 24px column so menu labels align. The workspace control has
  an icon-only Refresh action beside its label. The sidebar footer is right-aligned. The theme
  control is an icon beside a single account cell; identity and Sign out appear on separate lines.
  Board columns use a responsive grid with a minimum 240px width; wrap columns rather than causing
  page-level horizontal scroll.
- One shared board belongs to each workspace; projects classify items optionally. Project, assignee
  and label filters sit beside Scope in the planning toolbar (including unassigned and named
  assignees), never in the sidebar and never as a planning boundary. The planning toolbar also
  offers a Board/List presentation toggle; Kanban is the default, while List groups the same
  filtered work by the ordered board columns without changing navigation or scope semantics. Scope
  lists Active sprints, Backlog, and All open work in that order. WIP counts the whole workspace
  column, regardless of filtering. List sections remain visible when empty and can be expanded,
  collapsed, and used as drop targets. Desktop List rows use an Asana-like table grid with separate
  Title, Project, Assignee, Labels, Sprints, and Links / Status columns plus a shared header;
  descriptions are not shown and the title cell is title-only. Links / Status owns blocked/archived
  state, a Board-aligned `GitLab links · count` header with View observations beside the label
  and left-aligned when wrapped, GitLab MR links one per line, and the attachment icon/count on its own line without a full-width
  border. Observation status popovers are positioned against the viewport so list containers
  do not clip the last row. The Project cell shows only the project. When the detail pane is open,
  List hides the Sprints and Links / Status columns and expands the desktop detail track to
  `minmax(420px, 520px)` so the selected editor has more room. At 480px and below, cells become
  labeled stacked fields without page-level horizontal scrolling. With no selected item, desktop
  List uses a `minmax(0, 1fr) minmax(360px, 440px)` work-list/detail-pane split; below the desktop
  breakpoint, the detail pane becomes a full-width stacked section. Project management uses the
  existing dialog/controls, not a new component variant.
- Cards show project (or No project) and all open sprint memberships as badges; project and assignee
  share a metadata row, with the assignee aligned right. Cards show attachments in a compact Asana-like
  collapsed file dropdown at the bottom of the card, separated by a divider and using a fixed-size
  open/close cue with a paperclip/count cue; opening it reveals a vertical quick-download list with
  single-line file-type marks, truncated names and sizes, saving card space without page-level scroll;
  file-type marks expose the MIME type in the tile hover/focus description. The dropdown and editor
  action menus close when clicking elsewhere. The item editor uses the same compact
  file tiles and an Asana-like Add attachment action that opens
  the file picker and uploads the selected file; files can also be dropped onto the section. Editor
  tiles expose removal from an overflow action menu, and cancelling the picker leaves the card open.
  Members and admins can upload or remove files from active cards; viewers can download them. The attachment section appears before comments. At 1000px
  and above, the item editor puts title and description on the left and selection controls on the
  right; it stacks below that width.
  Wide layouts place comments below the description in the left pane; stacked layouts place them
  after the controls. Project and assignee use the same filterable single-selection dropdown as
  the other selection fields. The control pane orders Assignee, Labels, Project, Open sprints,
  Depends on and GitLab links, followed by a divider and the native `Move to` select.
  Selection fields start in display mode; their Edit link reveals the native select or checkbox
  menu.
  Multi-select values remain removable chips while editing, with a token-based shadow. GitLab links
  have a paste-URL field below the picker; Enter or Get resolves and appends an approved MR link.
  Add link opens the quick-scope and search fallback. Static field guidance uses an opaque ? popover
  with a line-colored shadow; the work-item header popover shows Card ID and Revision on separate
  lines. Modal cards close when clicking outside them.
  Closed-sprint membership is displayed read-only. Descriptions and comments use a GitLab-like
  Markdown editor with a compact single-row icon bar fused to the top of its input. Preview mode
  has only a text Edit control; edit mode starts with text Preview followed by flat, denser
  formatting icons with 28px hit areas. Related tools are separated by vertical rules. The bar
  stays on one line, fits the standard editor width and may scroll on very narrow screens.
  Descriptions open in Preview;
  comments open in Write. Safe rendered HTML is used for previews; raw HTML is never executed.
  Item context uses a flat append-only comment list with the author and creation time; members
  and admins can add comments, viewers can read them, and no comment can be edited or deleted.
  Comment entries use a compact GitLab-like activity timeline:
  a 24px member avatar at left, author/time metadata and a bordered body at right, with a connector
  between entries. The member/admin composer follows the list so newly appended comments remain in
  chronological flow. Comments are stored and loaded separately from planning revisions, audit
  snapshots, and burn-down history; the item editor has no decision-note field. Multiple active
  sprints are allowed. Closing one does not remove assignments to other open sprints. The footer
  keeps Save, Archive and Cancel visible while item fields scroll.
- Cards use the item title as a header, followed by project, assignee, labels, and blocked state.
  Descriptions remain available in the editor but are not shown on Kanban cards or List rows. The
  native item ID is not displayed on cards. Cards and board columns use a restrained accent-border
  hover cue. Card
  ordering uses drag-and-drop; there are no separate up/down controls. The item editor’s `Move to`
  select remains the keyboard movement mechanism. Cards are draggable from their body
  context, and columns are draggable from their headers, moving cards before/after cards or to a
  column’s end and reordering columns before/after another column. Drops use the same
  revision-checked commands; no optimistic rearrangement. Accent outlines mark drop targets, with
  top/bottom borders marking insertion. Filtering never changes project or sprint membership.
  Archived cards and viewers cannot drag.
- Projects and GitLab integration share a single-column Projects maintenance view, with GitLab
  integration first. Its show state displays approved GitLab project chips; `Edit integration` keeps
  the existing inline approval form. Project editing uses its existing dialog. Members have a dedicated Members
  view where admins can search available GitLab users, add or remove members, change roles, and maintain
  display names; adding a user defaults the workspace name to the GitLab profile name and shows the
  stored GitLab subject as a read-only field. Listings show the name, optional GitLab username and a
  color-coded role chip using only the role name, without the subject or permission description;
  OAuth supplies the signed-in user’s profile, while other numeric members need the server-side read
  connector; bootstrap, non-GitLab or unavailable identities may not have a GitLab username or avatar.
  Non-admins can review the roster
  only. Workspace labels have a dedicated Labels maintenance view with
  a compact responsive grid for create/rename/delete and color management. Deletion confirms removal
  from all cards, including archived work. Names may use an optional `scope::value` form such as
  `type::bug` or `priority::high`. Item label chips use their chosen palette colors and expose an x
  removal action; Edit opens their dropdown. Form input labels are semibold; control text remains
  normal-weight. Names are plain text, at most 60 bytes.
- Assignee cards show an optional 24px circular GitLab avatar and display name when profile data is
  available from the configured read connector or current session. Assignee options and the Members
  dialog show display names, falling back to an admin-maintained name, the current session name, or
  an explicitly unnamed member identifier. Workspace admins can maintain missing names via Members;
  subjects remain the stored identity.
- Cards group associated merge requests in a labeled GitLab links block: each appears once as a
  compact direct GitLab link (`MR !IID`) with a compact non-interactive status icon whose single
  custom hover/focus tooltip and accessible label summarize the cached observation (without a native
  title tooltip), plus a `View observations` action in
  the block header. Each MR observation includes its corresponding latest
  head pipeline status. The observations dialog exposes direct MR and pipeline links; the item
  editor manages associations with a dropdown multi-select, a paste-URL field and a button for
  the approved-link search fallback.
  Observation details use existing setup rows, badges, forms and live errors. Provider text, URLs
  and SHAs wrap within setup rows rather than causing horizontal scrolling. Display precise
  successful-refresh and latest-attempt times and explicitly mark unobserved, stale, unavailable,
  inaccessible, and not-found observations. A 404 means missing OR hidden, not proof of deletion.
  Old-head pipeline success is unknown for the current head. Provider errors preserve last-known
  data.
- Integration setup displays the operator-configured instance (never a free-form fetch URL). Admins
  approve numeric GitLab projects from a searchable connector-provided multi-select with explicit
  workspace-wide metadata visibility consent. Revoking approvals removes affected links/caches, not
  cards or audit. Members attach structured merge-request coordinates and can manually refresh;
  viewers only read. Refresh never alters planning state. Legacy direct pipeline records remain
  readable but new links are MR-only. The dialog describes the configured background interval (or
  manual-only mode). Queued hints mark cached observations stale until fetched; outdated provider
  versions never replace newer cache entries. Board summaries reload cached observations every 15
  seconds while idle, without moving cards or stealing focus. Pause these reads during drags,
  dialogs, pending writes and hidden tabs; changes to planning revisions require explicit Refresh.
  Dialogs are snapshots: reopen to see new background results, or request a manual observation
  refresh.
- Proposals in the workspace header opens a paginated review list. Members import versioned JSON as
  a draft (never an executable script). Show claimed provenance separately from authenticated
  importer/reviewer, rationale, native source IDs, revisions, exact field-by-field before/after
  values, and import deduplication counts. Plain-text wrapping `pre` blocks reuse existing panel
  tokens; no HTML or Markdown execution. Approval requires a separate explicit checkbox and review
  rationale. The consent checkbox precedes its label inline, using body typography and the 8px gap
  token; checkbox width is intrinsic. Reject is separate. Stale previews disable approval and retain
  the original document for copying/revision; never automatically rebase. Accepted reviews retain
  the exact historical diff, not a recomputed current diff. All controls use the existing
  dialog/form patterns; viewers cannot import/review-write.
- Sprint panel has goal, dates, lifecycle and scope counts, explicit start/close actions, and a
  read-only burn-down toggle. The chart expands inside the same panel on the Kanban board and Sprint
  planning displays; collapse state does not alter planning data. Selecting a closed sprint in the
  board Scope filter shows its corresponding read-only panel. Below 900px, the goal
  spans the full panel width above metrics/actions. Closing requires a rationale and an explicit
  additional carry-over choice (none, or another open sprint). Existing other sprint memberships are
  retained.
- Burn-down plots remaining native work-item count by day, a dashed ideal line, and the recorded
  scope so one chart can describe a sprint, project, member, or their intersection. Project and
  Assignee controls in the planning toolbar apply to an expanded chart. Project and assignee filters
  are evaluated against each dated native planning snapshot; scope changes remain visible. Future
  dates and periods without recorded history are blank rather than invented. The chart uses existing
  semantic tokens, places the active filter condition beside a compact figure on wide screens, and
  has an accessible horizontal daily-values table behind a native disclosure. It wraps below 900px
  without page-level horizontal scrolling.
- Modal dialogs have a 640px maximum width and a 16px viewport margin; the item editor expands to
  960px on wide screens. Textareas start at 120px high.
- Use native labeled forms and modal dialogs with focus return. All controls have visible focus;
  errors and save/conflict status are announced with live regions.
- Never optimistic-save silently: disable submit during requests, retain form input on
  validation/conflict, offer explicit refresh, and show successful saves.
- Viewer mode disables write actions. Archive view and history preserve completed work. History
  entries identify the current workspace as `workspace name (id)` and render known member actors as
  `name (subject)`. Loading, no-work, no-workspace, unavailable, and stale-revision states must be
  explicit. Render user Markdown through the safe renderer; never execute raw HTML.
- Theme toggle persists preference; initial theme follows system. Verify both themes at 1440px,
  768px, and 390px and keyboard-only planning workflows.
