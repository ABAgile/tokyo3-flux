---
name: flux-workflow
description: Use Flux's read-only team delivery view for sprint health and blockers.
---

# Flux workflow

## Setup

Build or install the Flux CLI and make it available to the tool. From the Flux repository, `make build` followed by `FLUX_CLI="$PWD/bin/flux" pi` is sufficient. If GitLab settings are only in `.env`, export them before starting Pi (for example, `set -a; . ./.env; set +a`).

Use `flux_today` as the source for the complete group-scoped delivery status. Use `flux_sprint_status` for a compact sprint-health summary with risks. Use `flux_triage`, `flux_standup`, `flux_review_queue`, and `flux_pipeline_failures` for focused read-only views. All tools refresh the active GitLab milestone through the local Flux CLI.

- Call `flux_sprint_status` for concise questions about sprint health, the goal, counts, or risks.
- Call `flux_triage` when the user asks what needs attention or what should happen next.
- Call `flux_standup` for a factual current-status standup; do not invent historical changes.
- Call `flux_review_queue` for open, non-draft merge requests with explicit review requests.
- Call `flux_pipeline_failures` for open merge requests whose latest relevant pipeline failed.
- Call `flux_today` when the user needs complete machine-readable work-item details.
- Treat all Flux tools as read-only; they do not approve, assign, edit, retry, or otherwise mutate GitLab.
- Explain statuses as derived signals from GitLab: `todo`, `in progress`, `awaiting review`, `pipeline failing`, `blocked`, `stale`, and `done`.
- Keep GitLab authoritative. Do not present the read-only tool as permission to mutate issues, merge requests, labels, or pipelines.
- If the tool fails, report the configuration or reconciliation error instead of guessing from stale conversation context.
