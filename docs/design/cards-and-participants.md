# Cards, dates and participants

- Cards show all associated projects (or No project) and all open sprint memberships as badges; project and the participant stack share a metadata row, with the stack aligned right.
  Project, sprint and label badges are told apart by shape and a leading glyph rather than colour alone, since label colours already own the palette: a project badge (`badge-project`) is `▤` on the inset surface with a 1px border-toned hairline, a sprint badge (`badge-sprint`) is `◷` on the same inset surface with no outline and body ink, and a label badge (`badge-label`) is `▥` on its own palette swatch with a faint hairline of its contrasting ink.
  Hairlines are inset shadows, so all badges keep one height, and the glyphs carry empty alternative text so screen readers read only the name.
  Work items may carry optional `start_date`, `end_date` and `due_date` values in `YYYY-MM-DD` form; start may not follow end, and due is independent.
  Cards and List rows show only the due date.
  A date earlier than the viewer's local today gets a visible `⚠ Overdue · date` danger badge and a static danger border while the card is live and outside a Done-category column; the browser recalculates this at local midnight.
  On cards the overdue badge sits centered beneath the title; other card due dates remain in the tag row.
  In List rows it sits below the title and is centered within its grid cell.
  In both the modal and List detail editors, the overdue badge sits in the header between the title and close button; a non-overdue due date remains in the status summary.
  There is no due-soon state or date filter.
  Start and end dates appear in the editor only.
  Participants are a read-only aggregate of who is involved with a card: the assignee, the reviewers of its cached merge-request observations, and its comment authors.
  The same person appears once with every role merged, ordered assignee, reviewers, then most recent commenters, and at most twelve are carried per card so a long thread never turns a board read into a roster dump.
  They are derived server-side in one grouped read, never per card, never written back, and never a reason to bump an item revision, so a new comment changes who is shown without touching planning state; the stack refreshes with the board rather than on the observation poll.
  The stack overlaps up to four 24px avatars and then a `+N` cue, each carrying an accessible name and role description, with `Unassigned` stated in words when a card has nobody.
  The assignee is distinguished by a static accent ring and an `Assignee` role in its label — no animation, and never by colour alone.
  Reviewer identities come from the cached provider observation and may belong to people who are not workspace members; an admin-maintained workspace name always wins over the provider's.
- Cards use the item title as a header, followed by project, assignee, labels, and blocked state.
  Descriptions remain available in the editor but are not shown on Kanban cards or List rows.
  The native item ID is not displayed on cards.
  Cards and board columns use a restrained accent-border hover cue.
- Assignee cards show an optional 24px circular GitLab avatar and display name when profile data is available from the configured read connector or current session.
  Assignee options and the Members dialog show display names, falling back to an admin-maintained name, the current session name, or an explicitly unnamed member identifier.
  Workspace admins can maintain missing names via Members; subjects remain the stored identity.
