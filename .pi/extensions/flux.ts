/**
 * Flux read-only tools for Pi.
 *
 * The extension deliberately shells out to the Flux CLI instead of duplicating
 * GitLab authentication or reconciliation logic. Set FLUX_CLI when the binary
 * is not on PATH (for example, /tokyo3/proj/abagile/flux/bin/flux).
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

type TodayMergeRequest = {
	id?: string;
	title?: string;
	state?: string;
	draft?: boolean;
	review_requested?: boolean;
	pipeline?: string;
};

type TodayItem = {
	id?: string;
	project_path?: string;
	title?: string;
	assignee?: string;
	status?: string;
	last_activity?: string;
	merge_requests?: TodayMergeRequest[];
};

type TodayPayload = {
	generated_at?: string;
	sprint?: { name?: string; goal?: string };
	summary?: {
		total?: number;
		counts?: Record<string, number>;
		items?: TodayItem[];
	};
};

type FluxTodayDetails = {
	command: string;
	generatedAt?: string;
	sprint?: string;
	itemCount?: number;
	truncated?: boolean;
	fullOutputPath?: string;
};

type FluxSprintDetails = FluxTodayDetails & {
	attentionCount: number;
};

type FluxListDetails = FluxTodayDetails & {
	resultCount: number;
};

const statusOrder = [
	"todo",
	"in progress",
	"awaiting review",
	"pipeline failing",
	"blocked",
	"stale",
	"done",
] as const;

const attentionOrder = ["blocked", "pipeline failing", "awaiting review", "stale", "todo"] as const;

const triageActions: Record<string, string> = {
	blocked: "resolve blocker",
	"pipeline failing": "fix failing pipeline",
	"awaiting review": "review merge request",
	stale: "re-engage owner",
	todo: "assign an owner",
};

const triagePriorities: Record<string, string> = {
	blocked: "P0",
	"pipeline failing": "P1",
	"awaiting review": "P1",
	stale: "P2",
	todo: "P2",
};

function errorText(stdout: string, stderr: string): string {
	const text = (stderr || stdout).trim().replace(/\s+/g, " ");
	return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

function parseTodayPayload(output: string): TodayPayload {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error("flux today returned invalid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("flux today returned an invalid status payload");
	}
	return value as TodayPayload;
}

async function saveFullOutput(output: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-flux-"));
	const path = join(directory, "today.json");
	await writeFile(path, output, "utf8");
	return path;
}

async function fetchToday(pi: ExtensionAPI, command: string, signal: AbortSignal): Promise<{ payload: TodayPayload; output: string }> {
	const result = await pi.exec(command, ["today", "--json"], {
		signal,
		timeout: 30_000,
	});
	if (result.killed) {
		throw new Error("Flux status lookup was cancelled or timed out");
	}
	if (result.code !== 0) {
		const detail = errorText(result.stdout, result.stderr);
		throw new Error(`flux today failed${detail ? `: ${detail}` : ""}`);
	}

	const output = result.stdout.trim();
	if (!output) {
		throw new Error("flux today returned no JSON output");
	}
	return { payload: parseTodayPayload(output), output };
}

function itemsOf(payload: TodayPayload): TodayItem[] {
	return Array.isArray(payload.summary?.items) ? payload.summary.items : [];
}

function countsOf(payload: TodayPayload): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const [status, count] of Object.entries(payload.summary?.counts ?? {})) {
		const normalized = typeof count === "number" && Number.isFinite(count) ? Math.trunc(count) : 0;
		if (normalized > 0) {
			counts[status] = normalized;
		}
	}
	if (Object.keys(counts).length > 0) {
		return counts;
	}
	for (const item of itemsOf(payload)) {
		if (item.status) {
			counts[item.status] = (counts[item.status] ?? 0) + 1;
		}
	}
	return counts;
}

function display(value: string | undefined, fallback: string): string {
	const normalized = value?.trim().replace(/\s+/g, " ");
	if (!normalized) {
		return fallback;
	}
	return normalized.length > 240 ? `${normalized.slice(0, 240)}…` : normalized;
}

function itemDescription(item: TodayItem): string {
	const id = display(item.id, "(unknown item)");
	const title = display(item.title, "(untitled)");
	const project = item.project_path?.trim() ? ` · ${display(item.project_path, "")}` : "";
	const assignee = item.assignee?.trim() ? ` · ${display(item.assignee, "")}` : " · unassigned";
	return `${id} · ${title}${project}${assignee}`;
}

function itemText(item: TodayItem): string {
	return `- ${item.status ?? "unknown"} · ${itemDescription(item)}`;
}

function attentionItems(payload: TodayPayload): TodayItem[] {
	const rank = new Map<string, number>(attentionOrder.map((status, index) => [status, index]));
	return itemsOf(payload)
		.filter((item) => item.status && rank.has(item.status))
		.sort((left, right) => rank.get(left.status!)! - rank.get(right.status!)!);
}

function detailsFor(command: string, payload: TodayPayload): FluxTodayDetails {
	return {
		command,
		generatedAt: payload.generated_at,
		sprint: payload.sprint?.name,
		itemCount: itemsOf(payload).length || payload.summary?.total,
	};
}

function workCountsText(payload: TodayPayload): string {
	const counts = countsOf(payload);
	const workCounts = statusOrder
		.filter((status) => counts[status] > 0)
		.map((status) => `${counts[status]} ${status}`);
	return workCounts.length > 0 ? ` · ${workCounts.join(" · ")}` : "";
}

function sprintStatusText(payload: TodayPayload): { text: string; attentionCount: number } {
	const total = typeof payload.summary?.total === "number" ? payload.summary.total : itemsOf(payload).length;
	const sprintName = payload.sprint?.name?.trim() || "(unnamed sprint)";
	const lines = [`Sprint: ${sprintName}`];
	if (payload.sprint?.goal?.trim()) {
		lines.push(`Goal: ${payload.sprint.goal.trim()}`);
	}

	lines.push(`Work: ${total} total${workCountsText(payload)}`);

	const attention = attentionItems(payload);
	lines.push("");
	if (attention.length === 0) {
		lines.push("Attention: none");
	} else {
		lines.push(`Attention: ${attention.length} item${attention.length === 1 ? "" : "s"}`);
		for (const item of attention.slice(0, 20)) {
			lines.push(itemText(item));
		}
		if (attention.length > 20) {
			lines.push(`- … ${attention.length - 20} more attention items`);
		}
	}
	return { text: lines.join("\n"), attentionCount: attention.length };
}

function triageText(payload: TodayPayload): { text: string; attentionCount: number } {
	const attention = attentionItems(payload);
	const lines = [`Triage: ${attention.length} item${attention.length === 1 ? "" : "s"} needing attention`];
	lines.push(`Sprint: ${display(payload.sprint?.name, "(unnamed sprint)")}`);
	if (payload.sprint?.goal?.trim()) {
		lines.push(`Goal: ${payload.sprint.goal.trim()}`);
	}
	lines.push("");
	if (attention.length === 0) {
		lines.push("No items need triage.");
		return { text: lines.join("\n"), attentionCount: 0 };
	}
	for (const item of attention.slice(0, 30)) {
		const status = item.status ?? "unknown";
		const priority = triagePriorities[status] ?? "P2";
		const action = triageActions[status] ?? "inspect item";
		lines.push(`- ${priority} ${status} · ${itemDescription(item)} → ${action}`);
	}
	if (attention.length > 30) {
		lines.push(`- … ${attention.length - 30} more triage items`);
	}
	return { text: lines.join("\n"), attentionCount: attention.length };
}

function sectionLines(label: string, items: TodayItem[], limit = 10): string[] {
	const lines = [`${label} (${items.length})`];
	if (items.length === 0) {
		lines.push("- none");
		return lines;
	}
	for (const item of items.slice(0, limit)) {
		lines.push(itemText(item));
	}
	if (items.length > limit) {
		lines.push(`- … ${items.length - limit} more`);
	}
	return lines;
}

function standupText(payload: TodayPayload): { text: string; attentionCount: number } {
	const items = itemsOf(payload);
	const attention = attentionItems(payload);
	const done = items.filter((item) => item.status === "done");
	const inProgress = items.filter((item) => item.status === "in progress");
	const known = new Set([...done, ...inProgress, ...attention]);
	const other = items.filter((item) => !known.has(item));
	const total = typeof payload.summary?.total === "number" ? payload.summary.total : items.length;
	const lines = ["Standup (current GitLab signals)", `Sprint: ${display(payload.sprint?.name, "(unnamed sprint)")}`];
	if (payload.generated_at?.trim()) {
		lines.push(`As of: ${payload.generated_at.trim()}`);
	}
	if (payload.sprint?.goal?.trim()) {
		lines.push(`Goal: ${payload.sprint.goal.trim()}`);
	}
	lines.push(`Work: ${total} total${workCountsText(payload)}`, "");
	lines.push(...sectionLines("Done", done), "");
	lines.push(...sectionLines("In progress", inProgress), "");
	lines.push(...sectionLines("Needs attention", attention));
	if (other.length > 0) {
		lines.push("", ...sectionLines("Other", other));
	}
	return { text: lines.join("\n"), attentionCount: attention.length };
}

type MergeRequestEntry = {
	item: TodayItem;
	request: TodayMergeRequest;
};

function mergeRequestsOf(
	payload: TodayPayload,
	predicate: (request: TodayMergeRequest) => boolean,
): MergeRequestEntry[] {
	const entries: MergeRequestEntry[] = [];
	for (const item of itemsOf(payload)) {
		for (const request of item.merge_requests ?? []) {
			if (predicate(request)) {
				entries.push({ item, request });
			}
		}
	}
	return entries.sort((left, right) => {
		const leftKey = `${left.item.project_path ?? ""}\u0000${left.request.id ?? ""}\u0000${left.item.id ?? ""}`;
		const rightKey = `${right.item.project_path ?? ""}\u0000${right.request.id ?? ""}\u0000${right.item.id ?? ""}`;
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}

function mergeRequestText(entry: MergeRequestEntry): string {
	const requestID = display(entry.request.id, "(unknown merge request)");
	const title = display(entry.request.title, "(untitled merge request)");
	const issue = display(entry.item.id, "(unknown issue)");
	const project = entry.item.project_path?.trim() ? ` · ${display(entry.item.project_path, "")}` : "";
	const owner = entry.item.assignee?.trim() ? ` · ${display(entry.item.assignee, "")}` : " · unassigned";
	const pipeline = display(entry.request.pipeline, "unknown");
	return `- ${requestID} · ${title} · issue ${issue}${project}${owner} · pipeline ${pipeline}`;
}

function queueText(
	payload: TodayPayload,
	heading: string,
	entries: MergeRequestEntry[],
): string {
	const lines = [`${heading}: ${entries.length} merge request${entries.length === 1 ? "" : "s"}`];
	lines.push(`Sprint: ${display(payload.sprint?.name, "(unnamed sprint)")}`, "");
	if (entries.length === 0) {
		lines.push("None.");
		return lines.join("\n");
	}
	for (const entry of entries.slice(0, 50)) {
		lines.push(mergeRequestText(entry));
	}
	if (entries.length > 50) {
		lines.push(`- … ${entries.length - 50} more merge requests`);
	}
	return lines.join("\n");
}

export default function fluxExtension(pi: ExtensionAPI) {
	const command = process.env.FLUX_CLI?.trim() || "flux";

	pi.registerTool({
		name: "flux_today",
		label: "Flux Today",
		description:
			"Read the current Flux group-scoped milestone status. This is read-only and refreshes from GitLab through the local Flux CLI; it does not mutate GitLab.",
		promptSnippet: "Read the current Flux team delivery status",
		promptGuidelines: [
			"Use flux_today before summarizing sprint health, blockers, or delivery status.",
			"Treat flux_today statuses as derived signals from GitLab, not as approval to change GitLab.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal) {
			const { payload, output } = await fetchToday(pi, command, signal);
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const details: FluxTodayDetails = detailsFor(command, payload);
			let text = truncation.content;
			if (truncation.truncated) {
				details.truncated = true;
				details.fullOutputPath = await saveFullOutput(output);
				text +=
					`\n\n[Output truncated: showing ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} ` +
					`and ${truncation.outputLines} of ${truncation.totalLines} lines. Full output: ${details.fullOutputPath}]`;
			}

			return {
				content: [{ type: "text", text }],
				details,
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("Flux today")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Refreshing Flux status…"), 0, 0);
			}
			const details = result.details as FluxTodayDetails | undefined;
			if (!details) {
				return new Text(theme.fg("success", "Flux status loaded"), 0, 0);
			}
			const itemCount = details.itemCount === undefined ? "" : ` · ${details.itemCount} items`;
			const truncated = details.truncated ? theme.fg("warning", " · truncated") : "";
			return new Text(
				theme.fg("success", `Flux status loaded${details.sprint ? ` · ${details.sprint}` : ""}${itemCount}`) +
					truncated,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "flux_sprint_status",
		label: "Flux Sprint Status",
		description:
			"Read a compact status of the current Flux sprint, including its goal, status counts, and work items needing attention. This is read-only and refreshes from GitLab through the local Flux CLI.",
		promptSnippet: "Summarize the current Flux sprint and risks",
		promptGuidelines: [
			"Use flux_sprint_status for a concise sprint-health summary instead of parsing every work item when the user asks how the sprint is going.",
			"Use flux_today when the user needs the complete machine-readable work-item snapshot.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal) {
			const { payload } = await fetchToday(pi, command, signal);
			const status = sprintStatusText(payload);
			const details: FluxSprintDetails = {
				...detailsFor(command, payload),
				attentionCount: status.attentionCount,
			};
			return {
				content: [{ type: "text", text: status.text }],
				details,
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("Flux sprint status")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Refreshing sprint status…"), 0, 0);
			}
			const details = result.details as FluxSprintDetails | undefined;
			if (!details) {
				return new Text(theme.fg("success", "Sprint status loaded"), 0, 0);
			}
			const itemCount = details.itemCount === undefined ? "" : ` · ${details.itemCount} items`;
			const attention = ` · ${details.attentionCount} attention`;
			return new Text(
				theme.fg("success", `Sprint status loaded${details.sprint ? ` · ${details.sprint}` : ""}${itemCount}${attention}`),
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "flux_triage",
		label: "Flux Triage",
		description:
			"Read and prioritize current Flux work needing attention. The result is read-only and uses deterministic GitLab-derived statuses; it does not change issues, merge requests, labels, or pipelines.",
		promptSnippet: "Prioritize current Flux work needing attention",
		promptGuidelines: [
			"Use flux_triage when the user asks what needs attention or what should happen next in the sprint.",
			"Treat flux_triage actions as suggested follow-up based on observed status, not as approval to mutate GitLab.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal) {
			const { payload } = await fetchToday(pi, command, signal);
			const triage = triageText(payload);
			const details: FluxSprintDetails = {
				...detailsFor(command, payload),
				attentionCount: triage.attentionCount,
			};
			return {
				content: [{ type: "text", text: triage.text }],
				details,
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("Flux triage")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Refreshing triage…"), 0, 0);
			}
			const details = result.details as FluxSprintDetails | undefined;
			if (!details) {
				return new Text(theme.fg("success", "Triage loaded"), 0, 0);
			}
			return new Text(
				theme.fg(
					"success",
					`Triage loaded${details.sprint ? ` · ${details.sprint}` : ""} · ${details.attentionCount} attention`,
				),
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "flux_standup",
		label: "Flux Standup",
		description:
			"Generate a concise, factual standup from the current Flux snapshot. It reports current GitLab signals and does not invent yesterday's changes or mutate GitLab.",
		promptSnippet: "Prepare a factual Flux sprint standup",
		promptGuidelines: [
			"Use flux_standup for a current status standup; do not imply historical progress that is not present in the Flux snapshot.",
			"Use flux_today when the user needs the underlying complete work-item data.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal) {
			const { payload } = await fetchToday(pi, command, signal);
			const standup = standupText(payload);
			const details: FluxSprintDetails = {
				...detailsFor(command, payload),
				attentionCount: standup.attentionCount,
			};
			return {
				content: [{ type: "text", text: standup.text }],
				details,
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("Flux standup")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Preparing standup…"), 0, 0);
			}
			const details = result.details as FluxSprintDetails | undefined;
			if (!details) {
				return new Text(theme.fg("success", "Standup loaded"), 0, 0);
			}
			return new Text(
				theme.fg(
					"success",
					`Standup loaded${details.sprint ? ` · ${details.sprint}` : ""} · ${details.attentionCount} attention`,
				),
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "flux_review_queue",
		label: "Flux Review Queue",
		description:
			"List open, non-draft Flux merge requests with an explicit review request. This is read-only and does not approve, assign, or modify merge requests.",
		promptSnippet: "List Flux merge requests awaiting review",
		promptGuidelines: [
			"Use flux_review_queue when the user asks which merge requests need review.",
			"Do not claim that flux_review_queue performs a review or changes reviewer assignments; it only reports GitLab data.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal) {
			const { payload } = await fetchToday(pi, command, signal);
			const entries = mergeRequestsOf(
				payload,
				(request) => request.state === "open" && request.review_requested === true && request.draft !== true,
			);
			const details: FluxListDetails = {
				...detailsFor(command, payload),
				resultCount: entries.length,
			};
			return {
				content: [{ type: "text", text: queueText(payload, "Review queue", entries) }],
				details,
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("Flux review queue")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Loading review queue…"), 0, 0);
			}
			const details = result.details as FluxListDetails | undefined;
			if (!details) {
				return new Text(theme.fg("success", "Review queue loaded"), 0, 0);
			}
			const count = `${details.resultCount} request${details.resultCount === 1 ? "" : "s"}`;
			return new Text(theme.fg("success", `Review queue loaded · ${count}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "flux_pipeline_failures",
		label: "Flux Pipeline Failures",
		description:
			"List open Flux merge requests whose latest relevant pipeline is failing. This is read-only and does not retry, cancel, or modify pipelines.",
		promptSnippet: "List Flux merge requests with failing pipelines",
		promptGuidelines: [
			"Use flux_pipeline_failures when the user asks about failing or broken pipelines.",
			"Use flux_today for complete work-item context if a pipeline failure needs more investigation.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal) {
			const { payload } = await fetchToday(pi, command, signal);
			const entries = mergeRequestsOf(payload, (request) => request.state === "open" && request.pipeline === "failed");
			const details: FluxListDetails = {
				...detailsFor(command, payload),
				resultCount: entries.length,
			};
			return {
				content: [{ type: "text", text: queueText(payload, "Pipeline failures", entries) }],
				details,
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("Flux pipeline failures")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Loading pipeline failures…"), 0, 0);
			}
			const details = result.details as FluxListDetails | undefined;
			if (!details) {
				return new Text(theme.fg("success", "Pipeline failures loaded"), 0, 0);
			}
			const count = `${details.resultCount} failure${details.resultCount === 1 ? "" : "s"}`;
			return new Text(theme.fg("success", `Pipeline failures loaded · ${count}`), 0, 0);
		},
	});
}
