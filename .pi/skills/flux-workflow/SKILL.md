---
name: flux-workflow
description: Use Flux's read-only team delivery view for sprint health and blockers.
---

# Flux workflow

## Setup

For local development, build or install the Flux CLI and make it available to the tool. From the Flux repository, `make build` followed by `FLUX_CLI="$PWD/bin/flux" pi` is sufficient. If GitLab settings are only in `.env`, export them before starting Pi (for example, `set -a; . ./.env; set +a`).

For API-backed access, set `FLUX_API_URL` to the authenticated Flux server and set `FLUX_API_TOKEN` to the server's scoped read-only machine credential. Set both together; the extension uses the API instead of the CLI. If neither is set, the local CLI remains the fallback. Never use the GitLab service token as `FLUX_API_TOKEN`. Give Pi only these API variables; do not export the server's `FLUX_GITLAB_SERVICE_TOKEN` or `FLUX_GITLAB_WRITE_TOKEN` into the Pi process.

Use `flux_today` as the source for the complete group-scoped delivery status. Use `flux_sprint_status` for a compact sprint-health summary with risks. Use `flux_triage`, `flux_standup`, `flux_review_queue`, and `flux_pipeline_failures` for focused read-only views. The CLI path reconciles the active GitLab milestone; the API path reads Flux's authenticated read model.

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

## Approved GitLab actions

Pi tools remain read-only. The browser cockpit is the only place to approve the first mutation: adding one explicit label to an issue in the current rolling read model. The cockpit offers only currently defined, unused GitLab project labels, then creates a short-lived dry-run plan, shows the exact issue and label, requires a second confirmation, rechecks GitLab freshness, and records the result in the Flux audit log. Configure a separate `FLUX_GITLAB_WRITE_TOKEN` only when enabling this action; without it, the cockpit displays that mutations are disabled, hides the action controls, and rejects action planning/confirmation. Suggested GitLab token name: `flux-mutation-bot`, with Reporter (or the minimum role allowed to edit issues and assign existing labels) and the `api` scope. Keep `FLUX_GITLAB_SERVICE_TOKEN` read-only. Selected historical/alternate milestone views do not expose mutation controls.
