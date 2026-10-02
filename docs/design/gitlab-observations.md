# GitLab links and observations

- Cards group associated merge requests in a labeled GitLab links block: each appears once as a compact direct GitLab link (`MR !IID`) with a compact non-interactive status icon whose single custom hover/focus tooltip and accessible label summarize the cached observation (without a native title tooltip), one per line so a status icon never separates from its link, plus the compact `◎` view action icon beside the block label (accessible name and custom tooltip `View observations`, as View scope has) that opens the observations dialog.
  Each MR observation includes its corresponding latest head pipeline status.
  The observations dialog exposes direct MR and pipeline links; the item editor manages associations with a dropdown multi-select, a paste-URL field and a button for the approved-link search fallback.
  Observation details use existing setup rows, badges, forms and live errors.
  Provider text, URLs and SHAs wrap within setup rows rather than causing horizontal scrolling.
  Display precise successful-refresh and latest-attempt times and explicitly mark unobserved, stale, unavailable, inaccessible, and not-found observations.
  A 404 means missing OR hidden, not proof of deletion.
  Old-head pipeline success is unknown for the current head.
  Provider errors preserve last-known data.
- Integration setup displays the operator-configured instance (never a free-form fetch URL).
  Admins approve numeric GitLab projects from a searchable connector-provided multi-select with explicit workspace-wide metadata visibility consent.
  Revoking approvals removes affected links/caches, not cards or audit.
  Members attach structured merge-request coordinates and can manually refresh; viewers only read.
  Refresh never alters planning state.
  Legacy direct pipeline records remain readable but new links are MR-only.
  The dialog describes the configured background interval (or manual-only mode).
  Queued hints mark cached observations stale until fetched; outdated provider versions never replace newer cache entries.
  Board summaries reload cached observations every 15 seconds while idle, without moving cards or stealing focus.
  Pause these reads during drags, dialogs, pending writes and hidden tabs; changes to planning revisions require explicit Refresh.
  Dialogs are snapshots: reopen to see new background results, or request a manual observation refresh.
