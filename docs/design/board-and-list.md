# Board and List

- Board columns sit in one row of equal height, each at least 240px wide, and the row never grows taller than the viewport minus the 32px gutter used by the List detail pane.
  A column keeps its head in place and scrolls its own cards, so every column's drop area stays on screen while a card is dragged from a long list to a short one; a short column is stretched to the row height so its empty space is a drop target too.
  When the columns do not fit the width, the row scrolls sideways inside the board rather than wrapping or causing page-level horizontal scroll; at 640px and below each column takes most of the width and the row snaps from column to column.
- The planning filter bar also offers a Board/List presentation toggle; Kanban is the default, while List groups the same filtered work by the ordered board columns without changing navigation or scope semantics.
- WIP counts the whole workspace column, regardless of filtering.
  List sections remain visible when empty and can be expanded, collapsed, and used as drop targets.
  Compact column summaries show the count as x/n WIP or No limit, even when a project lens is active.
  Selecting a named project shows current non-archived In scope, Done, Blocked, Unscheduled and active-sprint coverage counts; these are not historical metrics.
  The project lens uses the same full-width panel flow as sprint summaries, with a standard section gap between them.
  Desktop List rows use an Asana-like table grid with separate Title, Project, Participants, Sprints, Labels, and Links / Status columns plus a shared header, in the order a card shows them; the Participants cell carries the same participant avatars as a card, with no name text; descriptions are not shown and the title cell is title-only.
  Links / Status owns blocked/archived state, a Board-aligned `GitLab links · count` header with the compact `◎` observations action icon right beside the label, GitLab MR links one per line, and the attachment icon/count on its own line without a full-width border.
  Observation status popovers are positioned against the viewport so list containers do not clip the last row.
  The Project cell shows all associated projects.
  List columns follow the width the work list itself gets, not the viewport, so the sidebar and an open detail pane never starve the title: Title and Participants always show, and Labels (from 520px), Sprints (640px), Links / Status (900px) and Project (1040px) join in that order as the list widens.
  Fields that do not fit are left out rather than scrolled sideways, so rows keep their click, drag and header alignment; the full set is always in the detail pane.
  At 480px and below, cells become labeled stacked fields showing every field, without page-level horizontal scrolling.
  With no selected item, the work list takes the full width.
  With one selected, desktop List is a `minmax(0, 1fr) clamp(400px, 38%, 460px)` work-list/detail-pane split from 900px; below that, the detail pane becomes a full-width stacked section under the list.
  The sticky detail pane fits within the viewport with a 32px vertical gutter; its fields scroll independently and its footer stays visible.
- Card ordering uses drag-and-drop; there are no separate up/down controls.
  The item editor’s `Move to` select remains the keyboard movement mechanism.
  Cards are draggable from their body context, and columns are draggable from their headers, moving cards before/after cards or to a column’s end and reordering columns before/after another column.
  Drops use the same revision-checked commands.
  Card placement and archive state are rearranged locally as soon as the drop is accepted so the gesture feels immediate; the pending save is still announced, and a rejected or conflicting write restores the exact previous placement and shows the error.
  Nothing outside card placement, ordering, and archive state is applied before its write is acknowledged.
  Dragging toward the edge of a scroller scrolls it: the scroller under the pointer — a column's card list, the board's sideways row or the page — moves while the pointer is in a band along its edge, a fifth of its size between 48px and 120px, faster the closer to the edge, up to about 900px per second.
  Scroll snapping on the board is suspended while it is driven this way and returns when the drag ends.
  Accent outlines mark drop targets, with top/bottom borders marking insertion.
  Each Board card also has a `⋯` actions button at the end of its title row, starting on the same line as the title and always visible, that opens a menu with Copy link and Move to.
  Each List row has the same button at the end of its title row, top-aligned with the title as on a card, so it never crowds the select checkbox at the start of the row; the menu lines up with the button's right edge.
  Move to cascades into a list of the board's columns that leads with the card's own column, bold and unavailable as the list's heading, then a divider and the other columns in board order; a column at its WIP limit is listed as unavailable.
  A column opens a last level, Top and Bottom, when the pointer rests on it for a moment or on a click, Enter or Right; opened by the pointer it leaves keyboard focus where it was.
  Crossing other columns on the way to Top and Bottom does not switch the list, and unavailable entries open nothing.
  Bottom moves the card to the end of the column exactly as dropping it on the column does, and Top puts it before the first card shown there, as dropping it on the upper half of that card would; cards hidden by the filters are not counted, as for a drop.
  Both use the same immediate placement, Undo and WIP check as a drop, so the menu is also the way to move a card without dragging.
  Copy link is offered on every card, including archived ones and to viewers; Move to only where dragging is allowed.
  The menu opens with the keyboard (Enter, Space or Down on the button), moves with the arrow keys, opens each level with Right and leaves it with Left, and closes with Escape, returning focus to the button.
  The menu is positioned against the viewport, below the button or above when there is no room, with the cascade beside its item or on the other side, so a column's scrolling list never clips it; it closes when the page scrolls or resizes.
  Filtering never changes project or sprint membership.
  Archived cards and viewers cannot drag.
- List presentation supports bulk selection.
  Each non-archived row carries a checkbox in its title cell; selecting any row reveals a bulk bar above the table header showing the selected and shown counts, Assign, Add to sprint, Add label and Archive actions, Select all shown, and Clear selection.
  Each action opens the standard dialog to choose one value, then applies one revision-checked command per item in order, reporting progress and how many of the batch were applied; a conflict stops the batch rather than skipping ahead.
  Selection covers only currently filtered rows and is cleared when the filter, presentation, view, or workspace changes.
  Viewers have no bulk controls.
