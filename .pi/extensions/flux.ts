/**
 * Flux read-only tools for Pi.
 *
 * The extension uses Flux's authenticated API when configured and otherwise
 * shells out to the Flux CLI. It never duplicates GitLab authentication or
 * reconciliation logic. Set FLUX_CLI when the binary is not on PATH (for
 * example, /tokyo3/proj/abagile/flux/bin/flux).
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
	project_id?: number;
	project_path?: string;
	title?: string;
	state?: string;
	assignee?: string;
	labels?: string[];
	blocked?: boolean;
	status?: string;
	last_activity?: string;
	merge_requests?: TodayMergeRequest[];
};

type TodayPayload = {
	generated_at?: string;
	sprint?: { name?: string; goal?: string };
	total?: number;
	counts?: Record<string, number>;
	items?: TodayItem[];
	summary?: {
		total?: number;
		counts?: Record<string, number>;
		items?: TodayItem[];
	};
};

type ChangeField = {
	field?: string;
	before?: unknown;
	after?: unknown;
};

type FluxChange = {
	id?: string;
	kind?: string;
	observed_at?: string;
	snapshot_generated_at?: string;
	source_updated_at?: string;
	revision_hash?: string;
	milestone?: string;
	entity_key?: string;
	item_id?: string;
	project_id?: number;
	project_path?: string;
	changed_fields?: ChangeField[];
	before?: TodayItem;
	after?: TodayItem;
};

type CoveragePayload = {
	history_started_at?: string;
	last_observed_at?: string;
	observations?: number;
	successful_runs?: number;
	failed_runs?: number;
	current_scope_complete?: boolean;
	uncertainties?: string[];
};

type ChangesPayload = {
	status?: string;
	history_started_at?: string;
	last_observed_at?: string;
	observations?: number;
	changes?: FluxChange[];
	coverage?: CoveragePayload;
};

type ChangesParams = {
	since?: string;
	until?: string;
	item_id?: string;
	milestone?: string;
	limit?: number;
	include_baseline?: boolean;
};

type ItemHistoryParams = ChangesParams & {
	item_id: string;
};

type SnapshotParams = {
	at: string;
};

type SnapshotPayload = {
	status?: string;
	as_of?: string;
	observed_at?: string;
	sync_run_id?: string;
	source_watermark?: string;
	snapshot?: {
		generated_at?: string;
		sprint?: {
			name?: string;
			work_items?: unknown[];
		};
	};
	coverage?: CoveragePayload;
	uncertainties?: string[];
};

type FlowParams = {
	from?: string;
	to?: string;
	item_id?: string;
	milestone?: string;
};

type FlowPayload = {
	status?: string;
	changes?: number;
	truncated?: boolean;
	completed?: number;
	buckets?: unknown[];
	coverage?: CoveragePayload;
	uncertainties?: string[];
};

type HumanContextEntry = {
	id?: string;
	revision?: number;
	kind?: string;
	status?: string;
	confidence?: string;
	created_at?: string;
	updated_at?: string;
	author_subject?: string;
	statement?: string;
	category?: string;
	item_ids?: string[];
	milestone?: string;
	scope_action?: string;
	decision_owner?: string;
	reporting_from?: string;
	reporting_until?: string;
	effective_at?: string;
	source_urls?: string[];
	supersedes_id?: string;
};

type ContextCoveragePayload = {
	context_started_at?: string;
	retained_from?: string;
	last_updated_at?: string;
	provenance?: string;
	records?: number;
	revisions?: number;
	retention?: string;
	scope?: string;
	uncertainties?: string[];
};

type ContextPayload = {
	status?: string;
	entries?: HumanContextEntry[];
	coverage?: ContextCoveragePayload;
};

type ContextParams = {
	from?: string;
	to?: string;
	item_id?: string;
	kind?: string;
	limit?: number;
};

type ReportKind = "standup" | "sprint_health" | "refinement" | "planning" | "backlog" | "retrospective";

type ReportParams = {
	kind: ReportKind | string;
	from?: string;
	to?: string;
	milestone?: string;
	limit?: number;
};

type ReportPayload = {
	kind?: string;
	report?: Record<string, unknown>;
	[key: string]: unknown;
};

type FluxReportDetails = {
	command: string;
	kind: string;
	milestone?: string;
	itemCount: number;
	attentionCount: number;
	humanContextCount: number;
	uncertaintyCount: number;
	truncated?: boolean;
	fullOutputPath?: string;
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

type FluxChangesDetails = {
	command: string;
	changeCount: number;
	observationCount: number;
	uncertaintyCount: number;
	historyStartedAt?: string;
	lastObservedAt?: string;
	truncated?: boolean;
	fullOutputPath?: string;
};

type FluxSnapshotDetails = {
	command: string;
	asOf?: string;
	observedAt?: string;
	syncRunID?: string;
	generatedAt?: string;
	itemCount: number;
	uncertaintyCount: number;
	truncated?: boolean;
	fullOutputPath?: string;
};

type FluxFlowDetails = {
	command: string;
	changeCount: number;
	completedCount: number;
	bucketCount: number;
	uncertaintyCount: number;
	truncated?: boolean;
	fullOutputPath?: string;
};

type FluxContextDetails = {
	command: string;
	resultCount: number;
	revisionCount: number;
	uncertaintyCount: number;
	truncated?: boolean;
	fullOutputPath?: string;
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

function parseChangesPayload(output: string): ChangesPayload {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error("flux changes returned invalid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("flux changes returned an invalid history payload");
	}
	return value as ChangesPayload;
}

function parseObjectPayload(output: string, label: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error(`${label} returned invalid JSON`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} returned an invalid JSON payload`);
	}
	return value as Record<string, unknown>;
}

function parseSnapshotPayload(output: string): SnapshotPayload {
	return parseObjectPayload(output, "flux snapshot") as SnapshotPayload;
}

function parseFlowPayload(output: string): FlowPayload {
	return parseObjectPayload(output, "flux flow") as FlowPayload;
}

function parseContextPayload(output: string): ContextPayload {
	return parseObjectPayload(output, "flux context") as ContextPayload;
}

async function saveFullOutput(output: string, filename = "today.json"): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-flux-"));
	const path = join(directory, filename);
	await writeFile(path, output, "utf8");
	return path;
}

async function fetchTodayCLI(pi: ExtensionAPI, command: string, signal: AbortSignal): Promise<{ payload: TodayPayload; output: string }> {
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

function apiBaseURL(rawURL: string): URL {
	let base: URL;
	try {
		base = new URL(rawURL);
	} catch {
		throw new Error("FLUX_API_URL must be a valid HTTP(S) URL");
	}
	if (base.protocol !== "http:" && base.protocol !== "https:") {
		throw new Error("FLUX_API_URL must use HTTP or HTTPS");
	}
	if (base.username || base.password || base.search || base.hash) {
		throw new Error("FLUX_API_URL must not contain credentials, a query, or a fragment");
	}
	return base;
}

function apiTodayURL(rawURL: string): URL {
	return new URL("/api/today", apiBaseURL(rawURL));
}

function setChangeParams(endpoint: URL, params: ChangesParams): URL {
	if (params.since?.trim()) endpoint.searchParams.set("since", params.since.trim());
	if (params.until?.trim()) endpoint.searchParams.set("until", params.until.trim());
	if (params.item_id?.trim()) endpoint.searchParams.set("item_id", params.item_id.trim());
	if (params.milestone?.trim()) endpoint.searchParams.set("milestone", params.milestone.trim());
	if (params.limit !== undefined) endpoint.searchParams.set("limit", String(params.limit));
	if (params.include_baseline !== undefined) endpoint.searchParams.set("include_baseline", String(params.include_baseline));
	return endpoint;
}

function apiChangesURL(rawURL: string, params: ChangesParams): URL {
	return setChangeParams(new URL("/api/changes", apiBaseURL(rawURL)), params);
}

function apiItemHistoryURL(rawURL: string, params: ItemHistoryParams): URL {
	const endpoint = new URL(`/api/items/${encodeURIComponent(params.item_id)}/history`, apiBaseURL(rawURL));
	return setChangeParams(endpoint, params);
}

function apiSnapshotURL(rawURL: string, at: string): URL {
	return new URL(`/api/snapshots/${encodeURIComponent(at.trim())}`, apiBaseURL(rawURL));
}

function apiFlowURL(rawURL: string, params: FlowParams): URL {
	const endpoint = new URL("/api/flow", apiBaseURL(rawURL));
	if (params.from?.trim()) endpoint.searchParams.set("from", params.from.trim());
	if (params.to?.trim()) endpoint.searchParams.set("to", params.to.trim());
	if (params.item_id?.trim()) endpoint.searchParams.set("item_id", params.item_id.trim());
	if (params.milestone?.trim()) endpoint.searchParams.set("milestone", params.milestone.trim());
	return endpoint;
}

function apiContextURL(rawURL: string, params: ContextParams): URL {
	const endpoint = new URL("/api/context", apiBaseURL(rawURL));
	if (params.from?.trim()) endpoint.searchParams.set("from", params.from.trim());
	if (params.to?.trim()) endpoint.searchParams.set("to", params.to.trim());
	if (params.item_id?.trim()) endpoint.searchParams.set("item_id", params.item_id.trim());
	if (params.kind?.trim()) endpoint.searchParams.set("kind", params.kind.trim());
	if (params.limit !== undefined) endpoint.searchParams.set("limit", String(params.limit));
	return endpoint;
}

async function fetchTodayAPI(apiURL: string, token: string, signal: AbortSignal): Promise<{ payload: TodayPayload; output: string }> {
	const endpoint = apiTodayURL(apiURL);
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, 30_000);
	const onAbort = () => controller.abort();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", onAbort, { once: true });

	try {
		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
				},
				cache: "no-store",
				redirect: "manual",
				signal: controller.signal,
			});
		} catch (error) {
			if (timedOut) throw new Error("Flux API status lookup timed out");
			if (signal.aborted) throw new Error("Flux API status lookup was cancelled");
			const detail = error instanceof Error ? error.message : "request failed";
			throw new Error(`Flux API status lookup failed: ${detail}`);
		}
		if (response.status === 401 || response.status === 403) {
			throw new Error("Flux API authentication failed; check FLUX_API_TOKEN");
		}
		if (response.status >= 300 && response.status < 400) {
			throw new Error("Flux API redirected; check FLUX_API_URL and authentication");
		}
		if (!response.ok) {
			throw new Error(`Flux API returned HTTP ${response.status}`);
		}
		const output = (await response.text()).trim();
		if (!output) throw new Error("Flux API returned no JSON output");
		return { payload: parseTodayPayload(output), output };
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", onAbort);
	}
}

async function fetchToday(
	pi: ExtensionAPI,
	command: string,
	apiURL: string,
	apiToken: string,
	signal: AbortSignal,
): Promise<{ payload: TodayPayload; output: string }> {
	if (apiURL || apiToken) {
		if (!apiURL || !apiToken) {
			throw new Error("FLUX_API_URL and FLUX_API_TOKEN must be set together");
		}
		return fetchTodayAPI(apiURL, apiToken, signal);
	}
	return fetchTodayCLI(pi, command, signal);
}

async function fetchChangesCLI(
	pi: ExtensionAPI,
	command: string,
	params: ChangesParams,
	signal: AbortSignal,
): Promise<{ payload: ChangesPayload; output: string }> {
	const args = ["changes", "--json", "--limit", String(params.limit ?? 200)];
	if (params.since?.trim()) args.push("--since", params.since.trim());
	if (params.until?.trim()) args.push("--until", params.until.trim());
	if (params.item_id?.trim()) args.push("--item", params.item_id.trim());
	if (params.milestone?.trim()) args.push("--milestone", params.milestone.trim());
	if (params.include_baseline === true) args.push("--include-baseline");
	const result = await pi.exec(command, args, { signal, timeout: 30_000 });
	if (result.killed) throw new Error("Flux history lookup was cancelled or timed out");
	if (result.code !== 0) {
		const detail = errorText(result.stdout, result.stderr);
		throw new Error(`flux changes failed${detail ? `: ${detail}` : ""}`);
	}
	const output = result.stdout.trim();
	if (!output) throw new Error("flux changes returned no JSON output");
	return { payload: parseChangesPayload(output), output };
}

async function fetchChangesAPI(
	apiURL: string,
	token: string,
	params: ChangesParams,
	signal: AbortSignal,
): Promise<{ payload: ChangesPayload; output: string }> {
	const endpoint = apiChangesURL(apiURL, params);
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, 30_000);
	const onAbort = () => controller.abort();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", onAbort, { once: true });

	try {
		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
				},
				cache: "no-store",
				redirect: "manual",
				signal: controller.signal,
			});
		} catch (error) {
			if (timedOut) throw new Error("Flux API history lookup timed out");
			if (signal.aborted) throw new Error("Flux API history lookup was cancelled");
			const detail = error instanceof Error ? error.message : "request failed";
			throw new Error(`Flux API history lookup failed: ${detail}`);
		}
		if (response.status === 401 || response.status === 403) {
			throw new Error("Flux API authentication failed; check FLUX_API_TOKEN");
		}
		if (response.status >= 300 && response.status < 400) {
			throw new Error("Flux API redirected; check FLUX_API_URL and authentication");
		}
		if (!response.ok) throw new Error(`Flux API returned HTTP ${response.status}`);
		const output = (await response.text()).trim();
		if (!output) throw new Error("Flux API returned no history output");
		return { payload: parseChangesPayload(output), output };
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", onAbort);
	}
}

async function fetchChanges(
	pi: ExtensionAPI,
	command: string,
	apiURL: string,
	apiToken: string,
	params: ChangesParams,
	signal: AbortSignal,
): Promise<{ payload: ChangesPayload; output: string }> {
	if (apiURL || apiToken) {
		if (!apiURL || !apiToken) throw new Error("FLUX_API_URL and FLUX_API_TOKEN must be set together");
		return fetchChangesAPI(apiURL, apiToken, params, signal);
	}
	return fetchChangesCLI(pi, command, params, signal);
}

async function fetchJSONCLIOutput(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	signal: AbortSignal,
	label: string,
): Promise<string> {
	const result = await pi.exec(command, args, { signal, timeout: 30_000 });
	if (result.killed) throw new Error(`${label} was cancelled or timed out`);
	if (result.code !== 0) {
		const detail = errorText(result.stdout, result.stderr);
		throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
	}
	const output = result.stdout.trim();
	if (!output) throw new Error(`${label} returned no JSON output`);
	return output;
}

async function fetchReadOnlyAPIOutput(
	token: string,
	endpoint: URL,
	signal: AbortSignal,
	label: string,
): Promise<string> {
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, 30_000);
	const onAbort = () => controller.abort();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", onAbort, { once: true });

	try {
		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
				},
				cache: "no-store",
				redirect: "manual",
				signal: controller.signal,
			});
		} catch (error) {
			if (timedOut) throw new Error(`Flux API ${label} timed out`);
			if (signal.aborted) throw new Error(`Flux API ${label} was cancelled`);
			const detail = error instanceof Error ? error.message : "request failed";
			throw new Error(`Flux API ${label} failed: ${detail}`);
		}
		if (response.status === 401 || response.status === 403) {
			throw new Error("Flux API authentication failed; check FLUX_API_TOKEN");
		}
		if (response.status >= 300 && response.status < 400) {
			throw new Error("Flux API redirected; check FLUX_API_URL and authentication");
		}
		if (!response.ok) throw new Error(`Flux API returned HTTP ${response.status}`);
		const output = (await response.text()).trim();
		if (!output) throw new Error(`Flux API ${label} returned no JSON output`);
		return output;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", onAbort);
	}
}

async function fetchItemHistoryCLI(
	pi: ExtensionAPI,
	command: string,
	params: ItemHistoryParams,
	signal: AbortSignal,
): Promise<{ payload: ChangesPayload; output: string }> {
	const includeBaseline = params.include_baseline !== false;
	const args = ["history", "--json", "--item", params.item_id.trim(), "--limit", String(params.limit ?? 200)];
	if (params.since?.trim()) args.push("--since", params.since.trim());
	if (params.until?.trim()) args.push("--until", params.until.trim());
	if (params.milestone?.trim()) args.push("--milestone", params.milestone.trim());
	args.push(`--include-baseline=${includeBaseline}`);
	const output = await fetchJSONCLIOutput(pi, command, args, signal, "flux history");
	return { payload: parseChangesPayload(output), output };
}

async function fetchItemHistoryAPI(
	apiURL: string,
	token: string,
	params: ItemHistoryParams,
	signal: AbortSignal,
): Promise<{ payload: ChangesPayload; output: string }> {
	const request = { ...params, include_baseline: params.include_baseline !== false };
	const output = await fetchReadOnlyAPIOutput(token, apiItemHistoryURL(apiURL, request), signal, "item history lookup");
	return { payload: parseChangesPayload(output), output };
}

async function fetchItemHistory(
	pi: ExtensionAPI,
	command: string,
	apiURL: string,
	token: string,
	params: ItemHistoryParams,
	signal: AbortSignal,
): Promise<{ payload: ChangesPayload; output: string }> {
	if (apiURL || token) {
		if (!apiURL || !token) throw new Error("FLUX_API_URL and FLUX_API_TOKEN must be set together");
		return fetchItemHistoryAPI(apiURL, token, params, signal);
	}
	return fetchItemHistoryCLI(pi, command, params, signal);
}

async function fetchHistoricalSnapshotCLI(
	pi: ExtensionAPI,
	command: string,
	params: SnapshotParams,
	signal: AbortSignal,
): Promise<{ payload: SnapshotPayload; output: string }> {
	const output = await fetchJSONCLIOutput(pi, command, ["snapshot", "--json", "--at", params.at.trim()], signal, "flux snapshot");
	return { payload: parseSnapshotPayload(output), output };
}

async function fetchHistoricalSnapshotAPI(
	apiURL: string,
	token: string,
	params: SnapshotParams,
	signal: AbortSignal,
): Promise<{ payload: SnapshotPayload; output: string }> {
	const output = await fetchReadOnlyAPIOutput(token, apiSnapshotURL(apiURL, params.at), signal, "historical snapshot lookup");
	return { payload: parseSnapshotPayload(output), output };
}

async function fetchHistoricalSnapshot(
	pi: ExtensionAPI,
	command: string,
	apiURL: string,
	token: string,
	params: SnapshotParams,
	signal: AbortSignal,
): Promise<{ payload: SnapshotPayload; output: string }> {
	if (apiURL || token) {
		if (!apiURL || !token) throw new Error("FLUX_API_URL and FLUX_API_TOKEN must be set together");
		return fetchHistoricalSnapshotAPI(apiURL, token, params, signal);
	}
	return fetchHistoricalSnapshotCLI(pi, command, params, signal);
}

async function fetchFlowCLI(
	pi: ExtensionAPI,
	command: string,
	params: FlowParams,
	signal: AbortSignal,
): Promise<{ payload: FlowPayload; output: string }> {
	const args = ["flow", "--json"];
	if (params.from?.trim()) args.push("--from", params.from.trim());
	if (params.to?.trim()) args.push("--to", params.to.trim());
	if (params.item_id?.trim()) args.push("--item", params.item_id.trim());
	if (params.milestone?.trim()) args.push("--milestone", params.milestone.trim());
	const output = await fetchJSONCLIOutput(pi, command, args, signal, "flux flow");
	return { payload: parseFlowPayload(output), output };
}

async function fetchFlowAPI(
	apiURL: string,
	token: string,
	params: FlowParams,
	signal: AbortSignal,
): Promise<{ payload: FlowPayload; output: string }> {
	const output = await fetchReadOnlyAPIOutput(token, apiFlowURL(apiURL, params), signal, "flow lookup");
	return { payload: parseFlowPayload(output), output };
}

async function fetchFlow(
	pi: ExtensionAPI,
	command: string,
	apiURL: string,
	token: string,
	params: FlowParams,
	signal: AbortSignal,
): Promise<{ payload: FlowPayload; output: string }> {
	if (apiURL || token) {
		if (!apiURL || !token) throw new Error("FLUX_API_URL and FLUX_API_TOKEN must be set together");
		return fetchFlowAPI(apiURL, token, params, signal);
	}
	return fetchFlowCLI(pi, command, params, signal);
}

async function fetchContextCLI(
	pi: ExtensionAPI,
	command: string,
	params: ContextParams,
	signal: AbortSignal,
): Promise<{ payload: ContextPayload; output: string }> {
	const args = ["context", "--json", "--limit", String(params.limit ?? 50)];
	if (params.from?.trim()) args.push("--from", params.from.trim());
	if (params.to?.trim()) args.push("--to", params.to.trim());
	if (params.item_id?.trim()) args.push("--item", params.item_id.trim());
	if (params.kind?.trim()) args.push("--kind", params.kind.trim());
	const output = await fetchJSONCLIOutput(pi, command, args, signal, "flux context");
	return { payload: parseContextPayload(output), output };
}

async function fetchContextAPI(
	apiURL: string,
	token: string,
	params: ContextParams,
	signal: AbortSignal,
): Promise<{ payload: ContextPayload; output: string }> {
	const output = await fetchReadOnlyAPIOutput(token, apiContextURL(apiURL, params), signal, "human context lookup");
	return { payload: parseContextPayload(output), output };
}

async function fetchContext(
	pi: ExtensionAPI,
	command: string,
	apiURL: string,
	token: string,
	params: ContextParams,
	signal: AbortSignal,
): Promise<{ payload: ContextPayload; output: string }> {
	if (apiURL || token) {
		if (!apiURL || !token) throw new Error("FLUX_API_URL and FLUX_API_TOKEN must be set together");
		return fetchContextAPI(apiURL, token, params, signal);
	}
	return fetchContextCLI(pi, command, params, signal);
}

const reportKinds = new Set<ReportKind>([
	"standup",
	"sprint_health",
	"refinement",
	"planning",
	"backlog",
	"retrospective",
]);

function normalizedReportKind(raw: string): ReportKind {
	const kind = raw.trim().replace(/-/g, "_") as ReportKind;
	if (!reportKinds.has(kind)) throw new Error("kind must be standup, sprint_health, refinement, planning, backlog, or retrospective");
	return kind;
}

function reportPath(kind: string): string {
	return normalizedReportKind(kind).replace(/_/g, "-");
}

function apiReportURL(rawURL: string, params: ReportParams): URL {
	const endpoint = new URL(`/api/reports/${reportPath(params.kind)}`, apiBaseURL(rawURL));
	if (params.from?.trim()) endpoint.searchParams.set("from", params.from.trim());
	if (params.to?.trim()) endpoint.searchParams.set("to", params.to.trim());
	if (params.milestone?.trim()) endpoint.searchParams.set("milestone", params.milestone.trim());
	if (params.limit !== undefined) endpoint.searchParams.set("limit", String(params.limit));
	return endpoint;
}

async function fetchReportCLI(
	pi: ExtensionAPI,
	command: string,
	params: ReportParams,
	signal: AbortSignal,
): Promise<{ payload: ReportPayload; output: string }> {
	const args = [reportPath(params.kind), "--json", "--limit", String(params.limit ?? 20)];
	if (params.from?.trim()) args.push("--from", params.from.trim());
	if (params.to?.trim()) args.push("--to", params.to.trim());
	if (params.milestone?.trim()) args.push("--milestone", params.milestone.trim());
	const output = await fetchJSONCLIOutput(pi, command, args, signal, `flux ${reportPath(params.kind)} report`);
	return { payload: parseReportPayload(output), output };
}

async function fetchReportAPI(
	apiURL: string,
	token: string,
	params: ReportParams,
	signal: AbortSignal,
): Promise<{ payload: ReportPayload; output: string }> {
	const output = await fetchReadOnlyAPIOutput(token, apiReportURL(apiURL, params), signal, "report lookup");
	return { payload: parseReportPayload(output), output };
}

async function fetchReport(
	pi: ExtensionAPI,
	command: string,
	apiURL: string,
	token: string,
	params: ReportParams,
	signal: AbortSignal,
): Promise<{ payload: ReportPayload; output: string }> {
	const kind = normalizedReportKind(params.kind);
	const request = { ...params, kind };
	if (apiURL || token) {
		if (!apiURL || !token) throw new Error("FLUX_API_URL and FLUX_API_TOKEN must be set together");
		return fetchReportAPI(apiURL, token, request, signal);
	}
	return fetchReportCLI(pi, command, request, signal);
}

function parseReportPayload(output: string): ReportPayload {
	const value = parseObjectPayload(output, "flux report");
	const report = value.report;
	const candidate = report && typeof report === "object" && !Array.isArray(report) ? report : value;
	if (typeof candidate.kind !== "string" || !reportKinds.has(candidate.kind.replace(/-/g, "_") as ReportKind)) {
		throw new Error("flux report returned an invalid report kind");
	}
	return value as ReportPayload;
}

function reportValue(payload: ReportPayload): Record<string, unknown> {
	return payload.report && typeof payload.report === "object" && !Array.isArray(payload.report) ? payload.report : payload;
}

function arrayLength(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

function reportDetails(command: string, payload: ReportPayload): FluxReportDetails {
	const report = reportValue(payload);
	const coverage = report.coverage && typeof report.coverage === "object" && !Array.isArray(report.coverage) ? report.coverage as Record<string, unknown> : {};
	const counts = report.counts && typeof report.counts === "object" && !Array.isArray(report.counts) ? report.counts as Record<string, unknown> : {};
	const total = typeof report.total === "number" ? report.total : Object.values(counts).reduce((sum, value) => sum + (typeof value === "number" ? Math.max(0, Math.trunc(value)) : 0), 0);
	const attention = arrayLength(report.attention);
	const overlay = report.human_context_overlay && typeof report.human_context_overlay === "object" && !Array.isArray(report.human_context_overlay) ? report.human_context_overlay as Record<string, unknown> : {};
	const uncertainties = Array.isArray(coverage.uncertainties) ? coverage.uncertainties.length : 0;
	return {
		command,
		kind: String(report.kind ?? "report"),
		milestone: typeof report.milestone === "string" ? report.milestone : undefined,
		itemCount: total || arrayLength(report.items) || arrayLength(report.candidates) || arrayLength(report.candidate_items),
		attentionCount: attention,
		humanContextCount: arrayLength(overlay.entries),
		uncertaintyCount: uncertainties,
		truncated: report.truncated === true,
	};
}

function registerFixedReportTool(
	pi: ExtensionAPI,
	command: string,
	apiURL: string,
	token: string,
	source: string,
	name: string,
	label: string,
	kind: ReportKind,
): void {
	pi.registerTool({
		name,
		label,
		description: `Generate the bounded ${kind.replace(/_/g, " ")} report from Flux. It is read-only, preserves GitLab evidence and observed coverage, and labels human context as an overlay.`,
		promptSnippet: `Generate the Flux ${kind.replace(/_/g, " ")} report`,
		promptGuidelines: [
			`Use this tool for the ${kind.replace(/_/g, " ")} ceremony view; use flux_report for a different report kind.`,
			"Keep GitLab-derived evidence, Flux-observed history, and human_context_overlay separate; human context is reported input, not verified causality.",
			"Report as-of time, coverage, provenance, truncation, and uncertainties before making completeness claims.",
		],
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: "Inclusive RFC3339 report-window lower bound" })),
			to: Type.Optional(Type.String({ description: "Exclusive RFC3339 report-window upper bound" })),
			milestone: Type.Optional(Type.String({ description: "Milestone name; supported by the authenticated API path" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		}),

		async execute(_toolCallId, params, signal) {
			const request = (params || {}) as Omit<ReportParams, "kind">;
			const { payload, output } = await fetchReport(pi, command, apiURL, token, { ...request, kind }, signal);
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const details = reportDetails(source, payload);
			let text = truncation.content;
			if (truncation.truncated) {
				details.truncated = true;
				details.fullOutputPath = await saveFullOutput(output, `${kind}.json`);
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
			return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", `Generating ${kind.replace(/_/g, " ")} report…`), 0, 0);
			const details = result.details as FluxReportDetails | undefined;
			if (!details) return new Text(theme.fg("success", `${label} loaded`), 0, 0);
			const uncertainty = details.uncertaintyCount > 0 ? theme.fg("warning", ` · ${details.uncertaintyCount} uncertainties`) : "";
			const overlay = details.humanContextCount > 0 ? ` · ${details.humanContextCount} human overlay` : "";
			const truncated = details.truncated ? theme.fg("warning", " · bounded") : "";
			return new Text(theme.fg("success", `${label} loaded · ${details.itemCount} items · ${details.attentionCount} attention${overlay}`) + uncertainty + truncated, 0, 0);
		},
	});
}

function contextDetails(command: string, payload: ContextPayload): FluxContextDetails {
	const uncertainties = payload.coverage?.uncertainties ?? [];
	return {
		command,
		resultCount: Array.isArray(payload.entries) ? payload.entries.length : 0,
		revisionCount: typeof payload.coverage?.revisions === "number" ? payload.coverage.revisions : 0,
		uncertaintyCount: uncertainties.length,
	};
}

function snapshotDetails(command: string, payload: SnapshotPayload): FluxSnapshotDetails {
	const workItems = payload.snapshot?.sprint?.work_items;
	const uncertainties = [
		...(payload.coverage?.uncertainties ?? []),
		...(payload.uncertainties ?? []),
	];
	return {
		command,
		asOf: payload.as_of,
		observedAt: payload.observed_at,
		syncRunID: payload.sync_run_id,
		generatedAt: payload.snapshot?.generated_at,
		itemCount: Array.isArray(workItems) ? workItems.length : 0,
		uncertaintyCount: uncertainties.length,
	};
}

function flowDetails(command: string, payload: FlowPayload): FluxFlowDetails {
	const uncertainties = [
		...(payload.coverage?.uncertainties ?? []),
		...(payload.uncertainties ?? []),
	];
	return {
		command,
		changeCount: typeof payload.changes === "number" ? payload.changes : 0,
		completedCount: typeof payload.completed === "number" ? payload.completed : 0,
		bucketCount: Array.isArray(payload.buckets) ? payload.buckets.length : 0,
		uncertaintyCount: uncertainties.length,
		truncated: payload.truncated,
	};
}

function itemsOf(payload: TodayPayload): TodayItem[] {
	if (Array.isArray(payload.items)) return payload.items;
	return Array.isArray(payload.summary?.items) ? payload.summary.items : [];
}

function totalOf(payload: TodayPayload): number {
	if (typeof payload.total === "number") return payload.total;
	if (typeof payload.summary?.total === "number") return payload.summary.total;
	return itemsOf(payload).length;
}

function countsOf(payload: TodayPayload): Record<string, number> {
	const counts: Record<string, number> = {};
	const source = payload.counts ?? payload.summary?.counts ?? {};
	for (const [status, count] of Object.entries(source)) {
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
		itemCount: totalOf(payload),
	};
}

function changesOf(payload: ChangesPayload): FluxChange[] {
	return Array.isArray(payload.changes) ? payload.changes.filter((change) => change && typeof change === "object") : [];
}

function changesDetails(command: string, payload: ChangesPayload): FluxChangesDetails {
	const uncertainties = payload.coverage?.uncertainties ?? [];
	return {
		command,
		changeCount: changesOf(payload).length,
		observationCount: typeof payload.observations === "number" ? payload.observations : 0,
		uncertaintyCount: uncertainties.length,
		historyStartedAt: payload.history_started_at ?? payload.coverage?.history_started_at,
		lastObservedAt: payload.last_observed_at ?? payload.coverage?.last_observed_at,
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
	const total = totalOf(payload);
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
	const total = totalOf(payload);
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
	const apiURL = process.env.FLUX_API_URL?.trim() || "";
	const apiToken = process.env.FLUX_API_TOKEN?.trim() || "";
	const source = apiURL || apiToken ? "Flux API" : command;

	pi.registerTool({
		name: "flux_today",
		label: "Flux Today",
		description:
			"Read the current Flux group-scoped milestone status. This is read-only and uses the configured Flux API or local CLI; it does not mutate GitLab.",
		promptSnippet: "Read the current Flux team delivery status",
		promptGuidelines: [
			"Use flux_today before summarizing sprint health, blockers, or delivery status.",
			"Treat flux_today statuses as derived signals from GitLab, not as approval to change GitLab.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal) {
			const { payload, output } = await fetchToday(pi, command, apiURL, apiToken, signal);
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const details: FluxTodayDetails = detailsFor(source, payload);
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
		name: "flux_changes",
		label: "Flux Changes",
		description:
			"Read Flux's derived historical work-item changes for an optional time window, milestone, or item. This is read-only and reports observations made by Flux; it does not reconstruct unknown history or mutate GitLab.",
		promptSnippet: "Inspect changes observed by Flux",
		promptGuidelines: [
			"Use flux_changes for standups, carry-over analysis, or questions about what changed since a supplied time.",
			"Report history_started_at, last_observed_at, and observations before treating the result as complete.",
			"Distinguish Flux observed_at from GitLab's source timestamps and do not infer changes before history_started_at.",
			"Treat baseline records as the initial observation, not as proof that the work item was created in that window.",
		],
		parameters: Type.Object({
			since: Type.Optional(Type.String({ description: "Inclusive RFC3339 observation lower bound" })),
			until: Type.Optional(Type.String({ description: "Exclusive RFC3339 observation upper bound" })),
			item_id: Type.Optional(Type.String({ description: "Work-item ID filter" })),
			milestone: Type.Optional(Type.String({ description: "Milestone name filter" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
			include_baseline: Type.Optional(Type.Boolean({ description: "Include the initial baseline observation" })),
		}),

		async execute(_toolCallId, params, signal) {
			const request = (params || {}) as ChangesParams;
			const { payload, output } = await fetchChanges(pi, command, apiURL, apiToken, request, signal);
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const details: FluxChangesDetails = changesDetails(source, payload);
			let text = truncation.content;
			if (truncation.truncated) {
				details.truncated = true;
				details.fullOutputPath = await saveFullOutput(output, "changes.json");
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
			return new Text(theme.fg("toolTitle", theme.bold("Flux changes")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Loading Flux history…"), 0, 0);
			}
			const details = result.details as FluxChangesDetails | undefined;
			if (!details) {
				return new Text(theme.fg("success", "Flux history loaded"), 0, 0);
			}
			const truncated = details.truncated ? theme.fg("warning", " · truncated") : "";
			const uncertainty = details.uncertaintyCount > 0 ? theme.fg("warning", ` · ${details.uncertaintyCount} uncertainties`) : "";
			return new Text(
				theme.fg("success", `Flux history loaded · ${details.changeCount} changes · ${details.observationCount} observations`) +
					uncertainty +
					truncated,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "flux_item_history",
		label: "Flux Item History",
		description:
			"Read the observed Flux history for one work item, including baseline and before/after changes. This is read-only and does not reconstruct unsupported history or mutate GitLab.",
		promptSnippet: "Inspect one work item's observed Flux history",
		promptGuidelines: [
			"Use flux_item_history when a work item needs a chronological explanation of observed changes.",
			"Report coverage and uncertainties; a baseline is the first Flux observation, not proof of item creation.",
			"Use observed_at for when Flux saw a difference and do not claim it is the exact GitLab event time.",
		],
		parameters: Type.Object({
			item_id: Type.String({ description: "Work-item ID or entity key" }),
			since: Type.Optional(Type.String({ description: "Inclusive RFC3339 observation lower bound" })),
			until: Type.Optional(Type.String({ description: "Exclusive RFC3339 observation upper bound" })),
			milestone: Type.Optional(Type.String({ description: "Milestone name filter" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
			include_baseline: Type.Optional(Type.Boolean({ description: "Include the initial baseline observation" })),
		}),

		async execute(_toolCallId, params, signal) {
			const request = (params || {}) as ItemHistoryParams;
			if (!request.item_id?.trim()) throw new Error("item_id is required");
			const { payload, output } = await fetchItemHistory(pi, command, apiURL, apiToken, request, signal);
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const details: FluxChangesDetails = changesDetails(source, payload);
			let text = truncation.content;
			if (truncation.truncated) {
				details.truncated = true;
				details.fullOutputPath = await saveFullOutput(output, "item-history.json");
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
			return new Text(theme.fg("toolTitle", theme.bold("Flux item history")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Loading item history…"), 0, 0);
			const details = result.details as FluxChangesDetails | undefined;
			if (!details) return new Text(theme.fg("success", "Item history loaded"), 0, 0);
			const truncated = details.truncated ? theme.fg("warning", " · truncated") : "";
			return new Text(theme.fg("success", `Item history loaded · ${details.changeCount} changes`) + truncated, 0, 0);
		},
	});

	pi.registerTool({
		name: "flux_snapshot",
		label: "Flux Historical Snapshot",
		description:
			"Read a reconstructed Flux snapshot at an observed RFC3339 time. This is read-only, includes coverage metadata, and does not pretend to know unobserved history.",
		promptSnippet: "Inspect Flux at a historical observation time",
		promptGuidelines: [
			"Use flux_snapshot for point-in-time state at a supplied RFC3339 time.",
			"Check uncertainties and coverage before treating the reconstructed entity set as complete.",
			"Do not infer a state before history_started_at or after the last observed pull.",
		],
		parameters: Type.Object({
			at: Type.String({ description: "RFC3339 observation time" }),
		}),

		async execute(_toolCallId, params, signal) {
			const request = (params || {}) as SnapshotParams;
			if (!request.at?.trim()) throw new Error("at is required");
			const { payload, output } = await fetchHistoricalSnapshot(pi, command, apiURL, apiToken, request, signal);
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const details: FluxSnapshotDetails = snapshotDetails(source, payload);
			let text = truncation.content;
			if (truncation.truncated) {
				details.truncated = true;
				details.fullOutputPath = await saveFullOutput(output, "snapshot.json");
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
			return new Text(theme.fg("toolTitle", theme.bold("Flux historical snapshot")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Loading historical snapshot…"), 0, 0);
			const details = result.details as FluxSnapshotDetails | undefined;
			if (!details) return new Text(theme.fg("success", "Historical snapshot loaded"), 0, 0);
			const uncertainty = details.uncertaintyCount > 0 ? theme.fg("warning", ` · ${details.uncertaintyCount} uncertainties`) : "";
			return new Text(
				theme.fg("success", `Historical snapshot loaded · ${details.itemCount} items`) + uncertainty,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "flux_flow",
		label: "Flux Flow",
		description:
			"Read observation-based Flux flow and throughput metrics for an optional time window, item, or milestone. This is read-only and is not cycle-time, capacity, or causal analysis.",
		promptSnippet: "Inspect observed Flux delivery flow",
		promptGuidelines: [
			"Use flux_flow for observed starts, completions, blockers, status transitions, and daily buckets.",
			"Report coverage and uncertainties; do not present these counts as cycle time, capacity, or causal explanations.",
			"Use flux_changes or flux_item_history when the underlying before/after evidence is needed.",
		],
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: "Inclusive RFC3339 observation lower bound" })),
			to: Type.Optional(Type.String({ description: "Exclusive RFC3339 observation upper bound" })),
			item_id: Type.Optional(Type.String({ description: "Work-item ID or entity key filter" })),
			milestone: Type.Optional(Type.String({ description: "Milestone name filter" })),
		}),

		async execute(_toolCallId, params, signal) {
			const request = (params || {}) as FlowParams;
			const { payload, output } = await fetchFlow(pi, command, apiURL, apiToken, request, signal);
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const details: FluxFlowDetails = flowDetails(source, payload);
			let text = truncation.content;
			if (truncation.truncated) {
				details.truncated = true;
				details.fullOutputPath = await saveFullOutput(output, "flow.json");
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
			return new Text(theme.fg("toolTitle", theme.bold("Flux flow")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Loading Flux flow…"), 0, 0);
			const details = result.details as FluxFlowDetails | undefined;
			if (!details) return new Text(theme.fg("success", "Flux flow loaded"), 0, 0);
			const uncertainty = details.uncertaintyCount > 0 ? theme.fg("warning", ` · ${details.uncertaintyCount} uncertainties`) : "";
			const truncated = details.truncated ? theme.fg("warning", " · capped") : "";
			return new Text(
				theme.fg("success", `Flux flow loaded · ${details.changeCount} changes · ${details.completedCount} completed`) +
					uncertainty +
					truncated,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "flux_context",
		label: "Flux Human Context",
		description:
			"Read confirmed, human-reported delivery context for an optional time window, work item, or kind. This is read-only; it is an explicitly labeled overlay and does not change GitLab-derived status or counts.",
		promptSnippet: "Read confirmed human delivery context from Flux",
		promptGuidelines: [
			"Use flux_context when a ceremony report needs confirmed human explanations or scope decisions alongside GitLab evidence.",
			"Treat every entry as reported human context, not as GitLab evidence or an independently verified cause.",
			"Report the coverage and uncertainties, and do not infer blame, performance, medical details, or protected characteristics.",
		],
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: "Inclusive RFC3339 reporting-window lower bound" })),
			to: Type.Optional(Type.String({ description: "Exclusive RFC3339 reporting-window upper bound" })),
			item_id: Type.Optional(Type.String({ description: "Related work-item ID filter" })),
			kind: Type.Optional(Type.String({ description: "delay_explanation or scope_change" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
		}),

		async execute(_toolCallId, params, signal) {
			const request = (params || {}) as ContextParams;
			const { payload, output } = await fetchContext(pi, command, apiURL, apiToken, request, signal);
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const details: FluxContextDetails = contextDetails(source, payload);
			let text = truncation.content;
			if (truncation.truncated) {
				details.truncated = true;
				details.fullOutputPath = await saveFullOutput(output, "context.json");
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
			return new Text(theme.fg("toolTitle", theme.bold("Flux human context")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Loading human context…"), 0, 0);
			const details = result.details as FluxContextDetails | undefined;
			if (!details) return new Text(theme.fg("success", "Human context loaded"), 0, 0);
			const uncertainty = details.uncertaintyCount > 0 ? theme.fg("warning", ` · ${details.uncertaintyCount} uncertainties`) : "";
			const truncated = details.truncated ? theme.fg("warning", " · truncated") : "";
			return new Text(theme.fg("success", `Human context loaded · ${details.resultCount} entries · ${details.revisionCount} revisions`) + uncertainty + truncated, 0, 0);
		},
	});

	pi.registerTool({
		name: "flux_report",
		label: "Flux Ceremony Report",
		description:
			"Generate a bounded evidence-based Flux ceremony report: standup, sprint health, refinement, planning, backlog, or retrospective. It combines GitLab-derived observations with a clearly labeled confirmed human-context overlay and never mutates GitLab.",
		promptSnippet: "Generate an evidence-based Flux ceremony report",
		promptGuidelines: [
			"Use flux_report for standup, sprint health, refinement, planning, backlog, and retrospective views.",
			"Treat GitLab-derived statuses, counts, milestones, and observed history as authoritative; the human_context_overlay is reported context, not source truth or verified causality.",
			"Report the as-of time, evidence coverage, truncation, provenance, and uncertainties before making completeness claims.",
			"Do not infer capacity, cycle time, blame, performance, medical details, or protected characteristics from a report.",
		],
		parameters: Type.Object({
			kind: Type.String({ description: "standup, sprint_health, refinement, planning, backlog, or retrospective" }),
			from: Type.Optional(Type.String({ description: "Inclusive RFC3339 report-window lower bound" })),
			to: Type.Optional(Type.String({ description: "Exclusive RFC3339 report-window upper bound" })),
			milestone: Type.Optional(Type.String({ description: "Milestone name; supported by the authenticated API path" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		}),

		async execute(_toolCallId, params, signal) {
			const request = (params || {}) as ReportParams;
			const kind = normalizedReportKind(request.kind || "");
			const { payload, output } = await fetchReport(pi, command, apiURL, apiToken, { ...request, kind }, signal);
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const details = reportDetails(source, payload);
			let text = truncation.content;
			if (truncation.truncated) {
				details.truncated = true;
				details.fullOutputPath = await saveFullOutput(output, `${kind}.json`);
				text +=
					`\n\n[Output truncated: showing ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} ` +
					`and ${truncation.outputLines} of ${truncation.totalLines} lines. Full output: ${details.fullOutputPath}]`;
			}
			return {
				content: [{ type: "text", text }],
				details,
			};
		},

		renderCall(args, theme) {
			const kind = typeof args.kind === "string" ? args.kind.replace(/_/g, " ") : "ceremony";
			return new Text(theme.fg("toolTitle", theme.bold(`Flux ${kind} report`)), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Generating Flux report…"), 0, 0);
			const details = result.details as FluxReportDetails | undefined;
			if (!details) return new Text(theme.fg("success", "Flux report loaded"), 0, 0);
			const uncertainty = details.uncertaintyCount > 0 ? theme.fg("warning", ` · ${details.uncertaintyCount} uncertainties`) : "";
			const overlay = details.humanContextCount > 0 ? ` · ${details.humanContextCount} human overlay` : "";
			const truncated = details.truncated ? theme.fg("warning", " · bounded") : "";
			return new Text(theme.fg("success", `Flux ${details.kind} report loaded · ${details.itemCount} items · ${details.attentionCount} attention${overlay}`) + uncertainty + truncated, 0, 0);
		},
	});

	for (const [name, label, kind] of [
		["flux_sprint_health", "Flux Sprint Health", "sprint_health"],
		["flux_refinement", "Flux Refinement", "refinement"],
		["flux_planning", "Flux Planning", "planning"],
		["flux_backlog", "Flux Backlog", "backlog"],
		["flux_retrospective", "Flux Retrospective", "retrospective"],
	] as const) {
		registerFixedReportTool(pi, command, apiURL, apiToken, source, name, label, kind);
	}

	pi.registerTool({
		name: "flux_sprint_status",
		label: "Flux Sprint Status",
		description:
			"Read a compact status of the current Flux sprint, including its goal, status counts, and work items needing attention. This is read-only and uses the configured Flux API or local CLI.",
		promptSnippet: "Summarize the current Flux sprint and risks",
		promptGuidelines: [
			"Use flux_sprint_status for a concise sprint-health summary instead of parsing every work item when the user asks how the sprint is going.",
			"Use flux_today when the user needs the complete machine-readable work-item snapshot.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal) {
			const { payload } = await fetchToday(pi, command, apiURL, apiToken, signal);
			const status = sprintStatusText(payload);
			const details: FluxSprintDetails = {
				...detailsFor(source, payload),
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
			const { payload } = await fetchToday(pi, command, apiURL, apiToken, signal);
			const triage = triageText(payload);
			const details: FluxSprintDetails = {
				...detailsFor(source, payload),
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
			"Generate the bounded evidence-based standup report from Flux. It combines current GitLab-derived signals, observed history, and a clearly labeled human-context overlay without mutating GitLab.",
		promptSnippet: "Prepare an evidence-based Flux standup",
		promptGuidelines: [
			"Use flux_standup for the standup report and flux_report for other ceremony report kinds.",
			"Distinguish current GitLab signals and observed history from the human_context_overlay; context is reported input, not verified causality.",
			"Report coverage, as-of time, truncation, and uncertainties before making completeness claims.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal) {
			const { payload, output } = await fetchReport(pi, command, apiURL, apiToken, { kind: "standup", limit: 20 }, signal);
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const details = reportDetails(source, payload);
			let text = truncation.content;
			if (truncation.truncated) {
				details.truncated = true;
				details.fullOutputPath = await saveFullOutput(output, "standup-report.json");
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
			return new Text(theme.fg("toolTitle", theme.bold("Flux standup")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Preparing evidence-based standup…"), 0, 0);
			const details = result.details as FluxReportDetails | undefined;
			if (!details) return new Text(theme.fg("success", "Standup report loaded"), 0, 0);
			const uncertainty = details.uncertaintyCount > 0 ? theme.fg("warning", ` · ${details.uncertaintyCount} uncertainties`) : "";
			return new Text(theme.fg("success", `Standup report loaded · ${details.attentionCount} attention · ${details.humanContextCount} human overlay`) + uncertainty, 0, 0);
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
			const { payload } = await fetchToday(pi, command, apiURL, apiToken, signal);
			const entries = mergeRequestsOf(
				payload,
				(request) => request.state === "open" && request.review_requested === true && request.draft !== true,
			);
			const details: FluxListDetails = {
				...detailsFor(source, payload),
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
			const { payload } = await fetchToday(pi, command, apiURL, apiToken, signal);
			const entries = mergeRequestsOf(payload, (request) => request.state === "open" && request.pipeline === "failed");
			const details: FluxListDetails = {
				...detailsFor(source, payload),
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
