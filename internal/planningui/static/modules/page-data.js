// Paged reads that belong to a workspace: memberships, history, archived work
// and archived sprints. Each loader writes its page into the store unless its
// signal — by default the workspace session's — was aborted meanwhile.
import { api } from './api.js';
import { setState, state } from './state.js';
import { workspaceSignal } from './workspace-session.js';

/** @param {unknown} data */
function validWorkspaceList(data) {
  return (
    Array.isArray(data) &&
    data.every(
      (workspace) =>
        workspace &&
        typeof workspace.id === 'string' &&
        workspace.id &&
        typeof workspace.name === 'string' &&
        workspace.name &&
        typeof workspace.role === 'string' &&
        Number.isSafeInteger(workspace.revision),
    )
  );
}
/** @param {unknown} workspace */
export function validWorkspace(workspace) {
  return validWorkspaceList([workspace]);
}
/** @param {readonly Flux.Workspace[]} list */
export function workspaceListSignature(list) {
  return JSON.stringify(
    list.map((workspace) => [workspace.id, workspace.name, workspace.role, workspace.revision]),
  );
}
/** @param {string} id */
export function workspaceRoot(id) {
  return `/api/v2/workspaces/${encodeURIComponent(id)}`;
}
/**
 * @param {AbortSignal} [signal]
 * @returns {Promise<Flux.Workspace[]>}
 */
export async function loadWorkspaces(signal) {
  const next = await api('/api/v2/workspaces', { signal });
  if (!validWorkspaceList(next)) throw new Error('Workspace list is invalid. Refresh to retry.');
  setState({ workspaces: next });
  return next;
}

export const EMPTY_HISTORY = { history: [], historyBefore: 0, historyMore: false };
// Each page read returns a store patch; `load*` applies it directly.
/**
 * @param {boolean} reset
 * @param {AbortSignal} signal
 */
async function historyPage(reset, signal) {
  const before = !reset && state.historyBefore ? `?before=${state.historyBefore}` : '';
  const events = await api(`${state.root}/history${before}`, { signal });
  return {
    history: reset ? events : [...state.history, ...events],
    historyBefore: events.at(-1)?.id || 0,
    historyMore: events.length === 50,
  };
}
export async function loadHistory(reset = false, signal = workspaceSignal()) {
  const page = await historyPage(reset, signal);
  if (!signal.aborted) setState(page);
}

const ARCHIVE_PAGE = 50;
export const EMPTY_ARCHIVE = { archiveItems: [], archiveOffset: 0, archiveMore: false };
/**
 * @param {boolean} reset
 * @param {AbortSignal} signal
 */
async function archivePage(reset, signal) {
  const offset = reset ? 0 : state.archiveOffset;
  const page = await api(`${state.root}/archive?offset=${offset}&limit=${ARCHIVE_PAGE}`, {
    signal,
  });
  if (!Array.isArray(page)) throw new Error('Archive response is invalid. Refresh to retry.');
  return {
    archiveItems: reset ? page : [...state.archiveItems, ...page],
    archiveOffset: offset + page.length,
    archiveMore: page.length === ARCHIVE_PAGE,
  };
}
export async function loadArchive(reset = false, signal = workspaceSignal()) {
  const page = await archivePage(reset, signal);
  if (!signal.aborted) setState(page);
}

const SPRINT_HISTORY_PAGE = 50;
export const EMPTY_SPRINT_HISTORY = {
  sprintHistory: [],
  sprintHistoryOffset: 0,
  sprintHistoryMore: false,
  sprintHistoryError: '',
};
/**
 * @param {{ records: Flux.SprintHistoryRecord[], total: number, next_offset?: number } | null | undefined} page
 */
function validSprintHistoryPage(page) {
  return (
    page &&
    Array.isArray(page.records) &&
    Number.isSafeInteger(page.total) &&
    page.total >= 0 &&
    page.records.every(
      (record) =>
        record?.sprint &&
        typeof record.sprint.id === 'string' &&
        record.closure &&
        typeof record.closure.closed_at === 'string' &&
        !Number.isNaN(Date.parse(record.closure.closed_at)),
    ) &&
    (page.next_offset === undefined ||
      (Number.isSafeInteger(page.next_offset) && page.next_offset >= 0))
  );
}
/**
 * @param {boolean} reset
 * @param {AbortSignal} signal
 */
async function sprintHistoryPage(reset, signal) {
  const offset = reset ? 0 : state.sprintHistoryOffset;
  const page = await api(
    `${state.root}/sprints/archive?offset=${offset}&limit=${SPRINT_HISTORY_PAGE}`,
    { signal },
  );
  if (!validSprintHistoryPage(page))
    throw new Error('Sprint history response is invalid. Refresh to retry.');
  return {
    sprintHistory: reset ? page.records : [...state.sprintHistory, ...page.records],
    sprintHistoryOffset: offset + page.records.length,
    sprintHistoryMore: page.next_offset !== undefined,
    sprintHistoryError: '',
  };
}
export async function loadSprintHistory(reset = false, signal = workspaceSignal()) {
  const page = await sprintHistoryPage(reset, signal);
  if (!signal.aborted) setState(page);
}
// The reset first page of a view's own paged data, for a view change or a
// board reload that commits it together with the board.
/**
 * @param {string} view
 * @param {AbortSignal} signal
 */
export async function viewPage(view, signal) {
  if (view === 'history') return historyPage(true, signal);
  if (view === 'archive') return archivePage(true, signal);
  if (view === 'sprints') return sprintHistoryPage(true, signal);
  return {};
}
