# Item editor, Markdown and comments

- At 1000px and above, the item editor puts title and description on the left and selection controls on the right; it stacks below that width.
  Wide layouts place comments below the description in the left pane; stacked layouts place them after the controls.
  Assignee uses the same filterable single-selection dropdown as the other selection fields and offers an `Assign me` link beside Edit when the signed-in identity is a workspace member; the link sits immediately after the Assignee label, with Edit right-aligned.
  Project uses a filterable multi-selection dropdown and supports No project as its mutually exclusive empty choice.
  The control pane orders Assignee, Labels, Project, Dates, Open sprints, Depends on and GitLab links, followed by a divider and the native `Move to` select.
  Selection fields start in display mode; their Edit link reveals the native select or checkbox menu.
  The Dates group uses native date inputs behind the same display/Edit pattern, with all three fields optional.
  Start and end dates share a `·`-separated badge and use a dash for either unset value; the due date has its own badge.
  Editing shows a clear action beside each populated date, and places start and end inputs on one line whenever the control pane is wide enough; due has the same width below them.
  Multi-select values remain removable chips while editing, with a token-based shadow.
  GitLab links have a paste-URL field below the picker; Enter or Get resolves and appends an approved MR link.
  Add link opens the quick-scope and search fallback.
  Static field guidance uses an opaque `?` popover with a line-colored shadow; the work-item header uses an `i` popover of the same kind, since it states details rather than guidance, showing Card ID and Revision on separate lines.
  Both open on hover or keyboard focus and ignore a click, as every hint does.
  Modal cards and the List detail pane close when clicking outside them; a press that starts inside and ends outside, as when selecting text, does not count.
  In the List, controls, rows and dialogs outside the pane keep their own click behavior, and clicking another row keeps its discard confirmation.
  With unsaved input, including an unsent comment, the outside click asks whether to save before closing; agreeing saves and then closes, and declining keeps the editor open with the input intact.
  In the modal, Cancel, the close button and Escape with unsaved input ask before discarding, as the List pane does; changes are measured against the form as it opened.
  Save changes in the List detail pane saves and then closes it, like the modal; a failed save keeps it open with the input and the error.
  Closed-sprint membership is displayed read-only.
  Descriptions, comments and sprint goals use a GitLab-like Markdown editor with a compact single-row icon bar fused to the top of its input.
  Preview mode has only a text Edit control; edit mode starts with text Preview followed by flat, denser formatting icons with 28px hit areas.
  Related tools are separated by vertical rules.
  The bar stays on one line, fits the standard editor width and may scroll on very narrow screens.
  Descriptions open in Preview; comments and sprint goals open in Write.
  Sprint goals remain required and keep the 4,000-byte limit.
  Safe rendered HTML is used for previews; raw HTML is never executed, and unsafe links stay text.
  Item context uses a flat append-only comment list with the author and creation time; members and admins can add comments, viewers can read them, and no comment can be edited or deleted.
  Comment entries use a compact GitLab-like activity timeline: a 24px member avatar at left, author/time metadata and a bordered body at right, with a connector between entries.
  The member/admin composer follows the list so newly appended comments remain in chronological flow.
  Comments are stored and loaded separately from planning revisions, audit snapshots, and burn-down history; the item editor has no decision-note field.
- The footer keeps Save, Archive and Cancel visible while item fields scroll.
- Card status is one collapsed line of badges — column with its lifecycle category, `Live` or `Archived`, blocked, sprint count, GitLab link count — that expands to sprint names, closed-sprint history, cached observations and a note on how progress is derived, so it never pushes the editor fields down.
  Progress and presence stay separate facts: progress is the card's column category (To do, In progress, Done) as configured per column, while archived means off the board and out of open sprints.
  A Done card stays live until archived, and an archived card keeps the column it was archived from; neither badge is derived from the other.
  `In scope` stays reserved for sprint and project scope metrics and is never used for presence.
