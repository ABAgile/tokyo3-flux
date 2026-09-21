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
swatches and white on dark swatches. Use semantic tokens for all other UI colors. Motion is
optional decoration: any transition, animation, or smooth scrolling must be neutralised under
`prefers-reduced-motion: reduce`. No external fonts
or assets are required for the base UI; optional GitLab avatar images use the configured instance or
a validated HTTPS Gravatar avatar URL.

## Components and interaction

- All page content lives inside `#content`, which has exactly two mounts. The persistent planning
  frame is a `page-stack` carrying the project lens, the sprint summaries, the planning filter slot
  and the board body, so Board, List and Archive read like every other page. `#page-root` holds one
  page root for every other view, named by `data-content-view`: the standard `page-stack` (Projects,
  Sprints, Members, Labels, History) or a page-specific composition (the first-run checklist). Only
  one mount is shown at a time; the frame is hidden rather than rebuilt, so filters and summaries
  keep their state, and a view that patches its own root in place keeps it across renders.
  `aria-busy` belongs to the body being rebuilt, never to the region holding the filters. The stack
  is a single column with one 16px gap, so every page spaces its sections alike. Pages are assembled
  from shared components rather than per-page markup: `section-head` (title with right-aligned
  actions), `help` guidance text, the `empty` state, the bordered `panel` surface shared by sprint,
  project-lens, delivery-trend, burn-down, workspace-gate, first-run and maintenance panels, the
  `metrics` row of value/caption pairs, the filter slot/bar/chips, and the maintenance list/row used
  by Projects, Members and Labels. Board/List, GitLab integration, delivery trend and History stay
  page-specific compositions built from those same parts.
- Sidebar 208px on desktop, top navigation below 900px. Main padding 32px on desktop, 16px below
  900px. Navigation icons use a fixed 24px column so menu labels align. The workspace control has
  icon-only Create and Refresh actions beside its label. The sidebar footer is right-aligned. The theme
  control is an icon beside a single account cell; identity and Sign out appear on separate lines.
  Before a board is entered, a dedicated workspace gate asks users to choose among multiple
  memberships or create their first workspace; a single membership may open directly. Creation uses
  a labeled native form and makes the authenticated subject the initial administrator. The sidebar
  workspace selector remains available for switching after entry. Board columns use a responsive grid
  with a minimum 240px width; wrap columns rather than causing page-level horizontal scroll.
- Every filtered page uses the same `filter-bar` component: a horizontal line of labeled native
  selects and an optional search box on the left, and a right-aligned `filter-bar-count` for the
  visible record count. It is the only filter container; there is no separate toolbar component.
  Board and Archive host it in the planning frame's slot, above the board body and below the
  summaries. Pages
  that own a section layout — Projects and Sprints — host it inside their own section, immediately
  below the section heading it filters. The planning filter bar is one element that is relocated between
  those hosts rather than duplicated, so its controls keep their state and identity across views.
  Maintenance views without work filters hide it.
- One shared board belongs to each workspace; projects classify items optionally, and a work item
  may belong to multiple projects. Project, assignee and label filters sit beside Scope in the
  planning filter bar (including unassigned and named assignees), never in the sidebar and never as a
  planning boundary. Each of those three filters accepts several values at once. The native select
  adds one value and returns to its All entry, so it reads as an add-a-filter control; the active
  values appear as removable chips in a row directly above the planning content, with a Clear
  filters action once more than one is active. Values within a filter combine as OR; separate
  filters combine as AND. The empty choice (No project, Unassigned, No labels) means "no
  association" and is mutually exclusive with concrete values. The project lens, the new-item
  project default and the burn-down request apply only when exactly one concrete value is selected;
  a wider selection states that the chart shows all. Work search is debounced so a long board is
  filtered once per pause, and Enter applies the pending query immediately. The planning filter bar
  also offers a Board/List presentation toggle; Kanban is the default, while List groups the same
  filtered work by the ordered board columns without changing navigation or scope semantics. Scope
  lists Active sprints, Backlog, and All open work in that order. WIP counts the whole workspace
  column, regardless of filtering. List sections remain visible when empty and can be expanded,
  collapsed, and used as drop targets. Compact column summaries show the count as x/n WIP or No limit,
  even when a project lens is active. Selecting a named project shows current non-archived In scope, Done,
  Blocked, Unscheduled and active-sprint coverage counts; these are not historical metrics. The project
  lens uses the same full-width panel flow as sprint summaries, with a standard section gap between them.
  Desktop List rows use an Asana-like table grid with separate
  Title, Project, People, Labels, Sprints, and Links / Status columns plus a shared header; the People cell
  carries the same participant stack as a card followed by the assignee's name in text, so the column stays
  scannable as a table;
  descriptions are not shown and the title cell is title-only. Links / Status owns blocked/archived
  state, a Board-aligned `GitLab links · count` header with View observations beside the label
  and left-aligned when wrapped, GitLab MR links one per line, and the attachment icon/count on its own line without a full-width
  border. Observation status popovers are positioned against the viewport so list containers
  do not clip the last row. The Project cell shows all associated projects. When the detail pane is open,
  List hides the Sprints and Links / Status columns and expands the desktop detail track to
  `minmax(420px, 520px)` so the selected editor has more room. At 480px and below, cells become
  labeled stacked fields without page-level horizontal scrolling. With no selected item, desktop
  List uses a `minmax(0, 1fr) minmax(360px, 440px)` work-list/detail-pane split; below the desktop
  breakpoint, the detail pane becomes a full-width stacked section. Project management uses the
  existing dialog/controls, not a new component variant. Repeated secondary maintenance actions use compact
  icon buttons on wide layouts with accessible labels and native tooltips; labels return at narrow touch
  widths. This applies to project/sprint/member/label row and panel actions, including lifecycle and
  destructive actions; create/add primary actions retain visible text. Sprint panels use a compact two-column
  header: sprint information spans the left, actions sit in the top-right, and metrics sit below the actions; an
  expanded burn-down spans the full panel width. At constrained widths, the header becomes a single column and
  metrics use a full-width wrapping row.
- Cards show all associated projects (or No project) and all open sprint memberships as badges; project and the
  participant stack share a metadata row, with the stack aligned right. Project, sprint and label badges are told
  apart by shape and a leading glyph rather than colour alone, since label colours already own the palette: a
  project badge (`badge-project`) is `▤` on the inset surface with a 1px border-toned hairline, a sprint badge
  (`badge-sprint`) is `◷` on the same inset surface with no outline and body ink, and a label badge (`badge-label`) is `▥`
  on its own palette swatch with a faint hairline of its contrasting ink. Hairlines are inset shadows, so all badges keep
  one height, and the glyphs carry empty alternative text so screen readers read only the name. Participants are a read-only aggregate of
  who is involved with a card: the assignee, the reviewers of its cached merge-request observations, and its comment
  authors. The same person appears once with every role merged, ordered assignee, reviewers, then most recent
  commenters, and at most twelve are carried per card so a long thread never turns a board read into a roster dump.
  They are derived server-side in one grouped read, never per card, never written back, and never a reason to bump an
  item revision, so a new comment changes who is shown without touching planning state; the stack refreshes with the
  board rather than on the observation poll. The stack overlaps up to four 24px avatars and then a `+N` cue, each
  carrying an accessible name and role description, with `Unassigned` stated in words when a card has nobody. The
  assignee is distinguished by a static accent ring and an `Assignee` role in its label — no animation, and never by
  colour alone. Reviewer identities come from the cached provider observation and may belong to people who are not
  workspace members; an admin-maintained workspace name always wins over the provider's. Cards show attachments in a compact Asana-like
  collapsed file dropdown at the bottom of the card, separated by a divider and using a fixed-size
  open/close cue with a paperclip/count cue; opening it reveals a vertical quick-download list with
  single-line file-type marks, truncated names and sizes, saving card space without page-level scroll;
  file-type marks expose the MIME type in the tile hover/focus description. The dropdown and editor
  action menus close when clicking elsewhere. The item editor uses the same compact
  file tiles and an Asana-like Add attachment action that opens
  the file picker and uploads the selected file; files can also be dropped onto the section. Editor
  tiles expose removal from an overflow action menu, and cancelling the picker leaves the card open.
  Uploads show a determinate progress bar beside Add attachment and a percentage in the section
  status; an indeterminate bar is used when the browser cannot measure the request. Files may also
  be dropped directly onto a Kanban card or List row, which uploads to that card without opening the
  editor and reports progress through the shared status line. Only transfers carrying files are
  intercepted, so planning drags are unaffected, and archived cards reject file drops.
  Members and admins can upload or remove files from active cards; viewers can download them. The attachment section appears before comments. At 1000px
  and above, the item editor puts title and description on the left and selection controls on the
  right; it stacks below that width.
  Wide layouts place comments below the description in the left pane; stacked layouts place them
  after the controls. Assignee uses the same filterable single-selection dropdown as the other
  selection fields; Project uses a filterable multi-selection dropdown and supports No project as
  its mutually exclusive empty choice. The control pane orders Assignee, Labels, Project, Open sprints,
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
  revision-checked commands. Card placement and archive state are rearranged locally as soon as the
  drop is accepted so the gesture feels immediate; the pending save is still announced, and a
  rejected or conflicting write restores the exact previous placement and shows the error. Nothing
  outside card placement, ordering, and archive state is applied before its write is acknowledged.
  Accent outlines mark drop targets, with
  top/bottom borders marking insertion. Filtering never changes project or sprint membership.
  Archived cards and viewers cannot drag.
- Projects and GitLab integration share a single-column Projects maintenance view, with GitLab
  integration first. Its show state displays approved GitLab project chips; `Edit integration` keeps
  the existing inline approval form. Project editing uses its existing dialog. The workspace project
  list uses the plain page layout rather than a `maintenance-section` panel. Its compact horizontal
  filter bar sits below the title with the Assignee select first, the Label select second, a
  non-expanding accessible case-insensitive name search third, and a right-aligned visible project
  count. Assignee and Label accept several values using the same add-a-filter select, removable
  chips, OR-within/AND-across and exclusive-empty rules as the planning bar, with a Clear project
  filters action. They list projects holding current non-archived work that matches every active
  filter, with Unassigned and No labels matching empty values; no-match states are explicit and say
  whether the search, the filters, or both excluded everything. The Sprints page uses the same page
  layout as Projects: the read-only Delivery trend section first, then the sprint section whose
  heading is followed by the planning filter bar and its chips, then the sprint list. It keeps
  Project and Assignee in that bar, followed by Search. Those filters select which sprints are
  listed, not only what their metrics count: a sprint appears when its scope still holds work
  matching every active filter, and the delivery trend covers the same sprints. With no work filter
  active no sprint is excluded, so an empty sprint stays visible and plannable. Search
  case-insensitively matches sprint names and goals
  and shows a visible sprint count. Members have a dedicated Members
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
- The Sprints page opens with a read-only Delivery trend section above the sprint section: committed and
  completed counts for the last eight closed sprints as a grouped bar chart, last/average/best
  completed metrics, a legend, and an accessible sprint-values table behind a native disclosure. It
  is derived live from preserved closed-sprint scope and each card's current column, so it states
  that completion is not the state recorded at closure. Planning toolbar Project and Assignee
  filters apply to it. With no closed sprint it says so rather than plotting an empty chart.
- Sprint panel has goal, dates, lifecycle and scope counts, explicit start/close/re-open actions,
  and a read-only burn-down toggle. Re-opening a closed sprint restores its preserved scope as an
  active sprint while retaining any other open sprint assignments. The chart expands inside the same
  panel on the Kanban board and Sprint
  planning displays; collapse state does not alter planning data. Selecting a closed sprint in the
  board Scope filter shows its corresponding read-only panel. At constrained content widths, the goal
  spans the full panel width above metrics/actions, which stack without overlap; below 900px the compact panel spacing is used. Closing requires a rationale and an explicit
  additional carry-over choice (none, or another open sprint). Existing other sprint memberships are
  retained.
- Burn-down plots remaining native work-item count by day, a dashed ideal line, and the recorded
  scope so one chart can describe a sprint, project, member, or their intersection. Project and
  Assignee controls in the planning filter bar apply to an expanded chart. Project and assignee filters
  are evaluated against each dated native planning snapshot; scope changes remain visible. Future
  dates and periods without recorded history are blank rather than invented. The chart uses existing
  semantic tokens, places the active filter condition beside a compact figure on wide screens, and
  has an accessible horizontal daily-values table behind a native disclosure. It wraps below 900px
  without page-level horizontal scrolling.
- Modal dialogs have a 640px maximum width and a 16px viewport margin; the item editor expands to
  960px on wide screens. Dialog content always sits on an opaque panel surface over the dimmed
  backdrop, whether that content is a form or a plain panel. Textareas start at 120px high.
- Use native labeled forms and modal dialogs with focus return. All controls have visible focus.
  Every form control carries a name when its value is submitted and a unique id otherwise, so a
  control rendered twice — the item editor and the detail pane — never collides; text-like controls
  opt out of autofill unless a real autocomplete token applies. The
  main region is a focus-management target for the skip link and for Escape, not a control, so it
  never paints a focus ring around the whole page.
  Errors and save/conflict status are announced with live regions. Transient progress and errors are
  separate surfaces: a polite status line carries progress and success and is written only when its
  text changes, so an unchanged board is never re-announced, while errors persist in their own
  assertive bar with an explicit Dismiss until dismissed or cleared by a later success. Workspace
  revision belongs to the non-live count, never to the status line. The persistent bars — stale
  planning revision, undo offer and error — stay separate live regions because their politeness and
  lifetimes differ and they can be shown together, but they share one `notice-bar` presentation with
  accent, warning and danger variants: 12px text, an inset surface, and one trailing action button.
  Inline progress and validation inside forms, comments, attachments and the workspace gate use one
  status line: polite while it reports progress, assertive while it carries an error, hidden while it
  says nothing. Inline write failures use the matching assertive error line, which is empty and
  hidden until a request fails and is cleared by the next attempt. Guidance, empty states, status and
  error lines are always the shared components; pages add a variant class rather than new markup.
  History keeps its own row list rather than reshaping the maintenance list, and Board, List, GitLab
  integration and the delivery trend stay page-specific compositions built from the shared panels,
  heads, metrics and filter parts.
  A skip link precedes the sidebar so keyboard users reach the main region without traversing
  navigation.
- A workspace with no sprints and no work items shows a three-step setup path instead of empty
  columns: create a project, create and start a sprint, add the first work item. Steps may be done
  in any order, show a done state from current planning records, and link to the relevant view.
  Viewers never see it.
- Global keyboard shortcuts never fire while typing, while a dialog is open, or with Alt, Control or
  Meta held. Letter shortcuts match case-insensitively and accept Shift, so Caps Lock or a shifted
  key still activates them, and a modifier pressed on its own never cancels a pending chord. A chord
  announces the keys it is waiting for and stays open for 2.5 seconds. The shortcuts are:
  `/` focuses work search, `n` creates a work item, `r` refreshes, `g` followed by a view key
  navigates, and `?` opens a shortcut reference dialog. `Esc` leaves a focused page-level control and
  returns focus to the main region, so shortcuts are reachable again without using a pointer; inside
  a dialog, the detail pane, or an open selection menu it keeps its existing close behavior.
  Shortcut hints appear in the search placeholder and the reference dialog only.
- Never optimistic-save silently: disable submit during requests, retain form input on
  validation/conflict, offer explicit refresh, and show successful saves. Locally applied card
  placement and archive state are never silent either: the save is announced while it is in flight,
  and a failure rolls the board back rather than leaving an unsaved change on screen.
- Reversible single-command actions offer an explicit Undo. After archiving, restoring, moving, or
  reordering work, and after a bulk archive, a status bar below the notice names what happened and
  offers Undo for ten seconds. Undo issues the inverse revision-checked command, so a conflict is
  reported like any other write. Undo is offered only where a true inverse exists; irreversible
  maintenance such as deleting a label, column, or member keeps its existing confirmation dialog
  instead.
- List presentation supports bulk selection. Each non-archived row carries a checkbox in its title
  cell; selecting any row reveals a bulk bar above the table header showing the selected and shown
  counts, Assign, Add to sprint, Add label and Archive actions, Select all shown, and Clear
  selection. Each action opens the standard dialog to choose one value, then applies one
  revision-checked command per item in order, reporting progress and how many of the batch were
  applied; a conflict stops the batch rather than skipping ahead. Selection covers only currently
  filtered rows and is cleared when the filter, presentation, view, or workspace changes. Viewers
  have no bulk controls.
- Viewer mode disables write actions. Archive view and history preserve completed work. History
  entries identify the current workspace as `workspace name (id)` and render known member actors as
  `name (subject)`. Project maintenance rows offer a View scope action that selects the project
  lens and All open work, while new items inherit that project. Project scope defaults to List;
  changing the Project filter on Kanban preserves the current presentation. Board/List mode,
  project, assignee, label and scope are persisted as shareable URL query state; multi-value filters
  serialize as comma-separated values and unknown values are dropped on load. The open card is URL
  state too: `item` names it, opening and closing a card pushes a history entry so Back and Forward
  move between the board and the card, and unsaved editor input is protected before either the view
  or the address bar changes. The card heading carries its details popover followed by a compact
  `Copy link` text action, which yields a canonical `?workspace=<id>&item=<id>` URL carrying no
  filters, title, status or revision, so a reader's active scope can never hide the shared card.
  The action is never silent: for two seconds it states its own outcome in place — `✓ Link copied`
  or `! Not copied`, a state change rather than an animation — besides writing the status or error
  line.
  Card status is one collapsed line of badges — column with its lifecycle category, `Live`
  or `Archived`, blocked, sprint count, GitLab link count — that expands to sprint names,
  closed-sprint history, cached observations and a note on how progress is derived, so it never
  pushes the editor fields down. Progress and presence stay separate facts: progress is the
  card's column category (To do, In progress, Done) as configured per column, while archived means
  off the board and out of open sprints. A Done card stays live until archived, and an
  archived card keeps the column it was archived from; neither badge is derived from the other.
  `In scope` stays reserved for sprint and project scope metrics and is never used for presence. A shared link opens the current card — never a
  historical snapshot — resolving active cards from the board and every other card, archived
  included, from the single-card read rather than by walking archive pages. An archived card opens
  read-only with its `Archived` state, column and lifecycle category, blocked state, sprint
  memberships, comments, attachments and cached GitLab observations, plus a revision-checked
  Restore item action where permitted; restoring keeps the same card URL. GitLab entries stay
  labelled as cached provider data. A card that is missing or not readable says "Card not found or
  no longer available" and never silently opens another card. Loading, no-work, no-workspace, unavailable, and
  stale-revision states must be
  explicit. Render user Markdown through the safe renderer; never execute raw HTML.
- Theme toggle persists preference; initial theme follows system. Verify both themes at 1440px,
  768px, and 390px and keyboard-only planning workflows.
