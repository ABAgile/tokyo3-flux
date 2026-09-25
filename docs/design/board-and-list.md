# Board and List

- Board columns use a responsive grid with a minimum 240px width; wrap columns rather than causing page-level horizontal scroll.
- The planning filter bar also offers a Board/List presentation toggle; Kanban is the default, while List groups the same filtered work by the ordered board columns without changing navigation or scope semantics.
- WIP counts the whole workspace column, regardless of filtering.
  List sections remain visible when empty and can be expanded, collapsed, and used as drop targets.
  Compact column summaries show the count as x/n WIP or No limit, even when a project lens is active.
  Selecting a named project shows current non-archived In scope, Done, Blocked, Unscheduled and active-sprint coverage counts; these are not historical metrics.
  The project lens uses the same full-width panel flow as sprint summaries, with a standard section gap between them.
  Desktop List rows use an Asana-like table grid with separate Title, Project, People, Labels, Sprints, and Links / Status columns plus a shared header; the People cell carries the same participant stack as a card followed by the assignee's name in text, so the column stays scannable as a table; descriptions are not shown and the title cell is title-only.
  Links / Status owns blocked/archived state, a Board-aligned `GitLab links · count` header with View observations beside the label and left-aligned when wrapped, GitLab MR links one per line, and the attachment icon/count on its own line without a full-width border.
  Observation status popovers are positioned against the viewport so list containers do not clip the last row.
  The Project cell shows all associated projects.
  When the detail pane is open, List hides the Sprints and Links / Status columns and expands the desktop detail track to `minmax(420px, 520px)` so the selected editor has more room.
  At 480px and below, cells become labeled stacked fields without page-level horizontal scrolling.
  With no selected item, desktop List uses a `minmax(0, 1fr) minmax(360px, 440px)` work-list/detail-pane split; below the desktop breakpoint, the detail pane becomes a full-width stacked section.
  The sticky detail pane fits within the viewport with a 32px vertical gutter; its fields scroll independently and its footer stays visible.
- Card ordering uses drag-and-drop; there are no separate up/down controls.
  The item editor’s `Move to` select remains the keyboard movement mechanism.
  Cards are draggable from their body context, and columns are draggable from their headers, moving cards before/after cards or to a column’s end and reordering columns before/after another column.
  Drops use the same revision-checked commands.
  Card placement and archive state are rearranged locally as soon as the drop is accepted so the gesture feels immediate; the pending save is still announced, and a rejected or conflicting write restores the exact previous placement and shows the error.
  Nothing outside card placement, ordering, and archive state is applied before its write is acknowledged.
  Accent outlines mark drop targets, with top/bottom borders marking insertion.
  Filtering never changes project or sprint membership.
  Archived cards and viewers cannot drag.
- List presentation supports bulk selection.
  Each non-archived row carries a checkbox in its title cell; selecting any row reveals a bulk bar above the table header showing the selected and shown counts, Assign, Add to sprint, Add label and Archive actions, Select all shown, and Clear selection.
  Each action opens the standard dialog to choose one value, then applies one revision-checked command per item in order, reporting progress and how many of the batch were applied; a conflict stops the batch rather than skipping ahead.
  Selection covers only currently filtered rows and is cleared when the filter, presentation, view, or workspace changes.
  Viewers have no bulk controls.
