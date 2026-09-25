# URL state and card sharing

- Board/List mode, project, assignee, label and scope are persisted as shareable URL query state; multi-value filters serialize as comma-separated values and unknown values are dropped on load.
  The open card is URL state too: `item` names it, opening and closing a card pushes a history entry so Back and Forward move between the board and the card, and unsaved editor input is protected before either the view or the address bar changes.
  The card heading carries its details popover followed by a compact `Copy link` text action, which yields a canonical `?workspace=<id>&item=<id>` URL carrying no filters, title, status or revision, so a reader's active scope can never hide the shared card.
  The action is never silent: for two seconds it states its own outcome in place — `✓ Link copied` or `! Not copied`, a state change rather than an animation — besides writing the status or error line.
- A shared link opens the current card — never a historical snapshot — resolving active cards from the board and every other card, archived included, from the single-card read rather than by walking archive pages.
  An archived card opens read-only with its `Archived` state, column and lifecycle category, blocked state, sprint memberships, comments, attachments and cached GitLab observations, plus a revision-checked Restore item action where permitted; restoring keeps the same card URL.
  GitLab entries stay labelled as cached provider data.
  A card that is missing or not readable says "Card not found or no longer available" and never silently opens another card.
