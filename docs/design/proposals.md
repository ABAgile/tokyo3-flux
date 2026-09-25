# Proposals

- Proposals in the workspace header opens a paginated review list.
  Members import versioned JSON as a draft (never an executable script).
  Show claimed provenance separately from authenticated importer/reviewer, rationale, native source IDs, revisions, exact field-by-field before/after values, and import deduplication counts.
  Plain-text wrapping `pre` blocks reuse existing panel tokens; no HTML or Markdown execution.
  Approval requires a separate explicit checkbox and review rationale.
  The consent checkbox precedes its label inline, using body typography and the 8px gap token; checkbox width is intrinsic.
  Reject is separate.
  Stale previews disable approval and retain the original document for copying/revision; never automatically rebase.
  Accepted reviews retain the exact historical diff, not a recomputed current diff.
  All controls use the existing dialog/form patterns; viewers cannot import/review-write.
