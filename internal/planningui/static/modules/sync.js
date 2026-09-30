// Board refresh and merging, the workspace gate, and the background polls.
import { api, apiRevalidated } from './api.js';
import { beginWorkspaceSession, withWorkspace, workspaceSignal } from './workspace-session.js';
import { useEffect } from './vendor-preact.js';
import { setState, state, requireBoard } from './state.js';
import {
  notice,
  clearError,
  clearUndo,
  showPlanningChangeNotice,
  clearPlanningChangeNotice,
} from './notices.js';
import { knownFilters } from './filters.js';
import { isEditorOpen } from './dialog-state.js';
import { linkIdentitySignature, observationsChanged } from './gitlab-catalog.js';
import { persistWorkspaceURL } from './url-state.js';
import {
  EMPTY_ARCHIVE,
  EMPTY_HISTORY,
  EMPTY_SPRINT_HISTORY,
  loadWorkspaces,
  viewPage,
  workspaceListSignature,
  workspaceRoot,
} from './page-data.js';

/**
 * @param {unknown} previous
 * @param {unknown} next
 */
function sameValue(previous, next) {
  return JSON.stringify(previous) === JSON.stringify(next);
}
// Unchanged entities and lists keep their identity, so keyed components whose
// data did not change can skip rendering after a refresh.
/**
 * @template T
 * @param {T[] | undefined} previous
 * @param {T[] | undefined} next
 * @param {(value: T) => string} key
 * @returns {T[]}
 */
function mergeEntities(previous = [], next = [], key) {
  const existing = new Map(previous.map((value) => [key(value), value]));
  let changed = previous.length !== next.length;
  const merged = next.map((value, index) => {
    const current = existing.get(key(value));
    const kept = current && sameValue(current, value) ? current : value;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? merged : previous;
}
/**
 * @param {Flux.Board | undefined} previous
 * @param {Flux.Board} next
 * @returns {Flux.Board}
 */
export function mergeBoardData(previous, next) {
  if (!previous) return next;
  /**
   * @template {'participants' | 'closed_scope' | 'integration'} K
   * @param {K} name
   * @returns {Flux.Board[K]}
   */
  const list = (name) => (sameValue(previous[name], next[name]) ? previous[name] : next[name]);
  return {
    ...next,
    projects: mergeEntities(previous.projects, next.projects, (value) => value.id),
    labels: mergeEntities(previous.labels, next.labels, (value) => value.name),
    columns: mergeEntities(previous.columns, next.columns, (value) => value.id),
    items: mergeEntities(previous.items, next.items, (value) => value.id),
    sprints: mergeEntities(previous.sprints, next.sprints, (value) => value.id),
    members: mergeEntities(previous.members, next.members, (value) => value.subject),
    links: mergeEntities(previous.links, next.links, (value) => value.id),
    participants: list('participants'),
    closed_scope: list('closed_scope'),
    integration: list('integration'),
  };
}
/**
 * @param {string} scope
 * @param {Flux.Board} board
 */
function knownScope(scope, board) {
  return ['active', 'backlog', 'all'].includes(scope) ||
    board.sprints.some((sprint) => sprint.id === scope)
    ? scope
    : 'active';
}
// Returns to the workspace gate, discarding everything that belonged to the
// workspace and cancelling its work. An editor that is saving stays until its
// request settles.
/**
 * @param {Flux.State['workspaceGate']} mode
 * @param {string} [message]
 */
export function enterWorkspaceGate(mode, message) {
  beginWorkspaceSession();
  clearUndo();
  setState((current) => ({
    detail: undefined,
    selectedItemID: '',
    detailError: '',
    editorDialog: current.busy ? current.editorDialog : undefined,
    bulkSelection: [],
    board: undefined,
    root: undefined,
    boardETag: '',
    boardETagRoot: '',
    ...EMPTY_SPRINT_HISTORY,
    workspaceGate: mode,
    pendingPlanningURLState: undefined,
    planningURLReady: false,
  }));
  persistWorkspaceURL('');
  if (message) notice(message);
}
// One board or workspace-list load at a time: a new load aborts the one in
// flight, and leaving the workspace aborts it too. Only the current load
// clears the loading flag, so a superseded one never ends its successor's.
/** @type {AbortController | undefined} */
let currentLoad;
export function beginLoad() {
  currentLoad?.abort();
  const controller = new AbortController();
  currentLoad = controller;
  setState({ loading: true });
  return { controller, signal: withWorkspace(controller.signal) };
}
/** @param {{ controller: AbortController }} load */
export function finishLoad(load) {
  if (currentLoad !== load.controller) return;
  currentLoad = undefined;
  setState({ loading: false });
}
// Observation reads skip an unchanged digest until the fallback interval.
let observationDigest = '';
let observationReadAt = 0;
// preloaded carries a board a write already returned, so a saved change is
// applied without a second board read. Membership is still reloaded, because a
// change receipt says nothing about workspace access.
/** @param {{ board: Flux.Board, etag: string }} [preloaded] */
export async function refresh(preloaded) {
  if (state.busy || state.integrationFormOpen || !state.root) return false;
  const load = beginLoad();
  const { signal } = load;
  try {
    const memberships = await loadWorkspaces(signal);
    if (signal.aborted) return false;
    const selectedID =
      state.board?.workspace?.id ||
      memberships.find((workspace) => workspaceRoot(workspace.id) === state.root)?.id;
    if (!selectedID || !memberships.some((workspace) => workspace.id === selectedID)) {
      enterWorkspaceGate(
        memberships.length ? 'select' : 'create',
        memberships.length
          ? 'Workspace access changed. Choose an available workspace.'
          : 'Workspace access changed. Create a workspace to get started.',
      );
      return false;
    }
    const root = state.root;
    const cached = state.board && state.boardETagRoot === root ? state.boardETag : '';
    const response =
      preloaded?.board?.workspace?.id === selectedID
        ? { modified: true, etag: preloaded.etag, data: preloaded.board }
        : await apiRevalidated(`${root}/board`, cached, { signal });
    if (signal.aborted) return false;
    setState({ boardETag: response.etag, boardETagRoot: root });
    // The revision belongs in the non-live count, not in the polite status line:
    // repeating it on every poll would re-announce an unchanged board.
    if (!response.modified) {
      clearPlanningChangeNotice();
      clearError();
      notice('Up to date.');
      return true;
    }
    const board = mergeBoardData(state.board, response.data);
    observationDigest = '';
    observationReadAt = 0;
    // The view's own first page is reloaded with the board, so both are
    // committed in one update; a failed page read still applies the board.
    const apply = (/** @type {Partial<Flux.State>} */ pages) =>
      setState((current) => ({
        board,
        boardGeneration: current.boardGeneration + 1,
        workspaceGate: '',
        planningChangeNotice: false,
        errorText: '',
        attachmentLists: {},
        filters: knownFilters(current.filters, board),
        scope: knownScope(current.scope, board),
        ...EMPTY_HISTORY,
        ...EMPTY_ARCHIVE,
        ...EMPTY_SPRINT_HISTORY,
        ...pages,
      }));
    let pages;
    try {
      pages = await viewPage(state.view, signal);
    } catch (error) {
      if (!signal.aborted) {
        apply({});
        persistWorkspaceURL(board.workspace.id);
      }
      throw error;
    }
    if (signal.aborted) return false;
    apply(pages);
    persistWorkspaceURL(board.workspace.id);
    notice('Up to date.');
    return true;
  } catch (e) {
    if (!signal.aborted) notice(e.message, true);
    return false;
  } finally {
    finishLoad(load);
  }
}
// A digest that only ever reports "unchanged" is indistinguishable from a
// working one, so the board is re-read on a timer regardless of the digest.
// This bounds staleness if the digest ever stops tracking the board payload.
const OBSERVATION_FALLBACK_MS = 120000;
function pollBlocked() {
  return (
    state.busy || state.loading || state.integrationFormOpen || state.dragging || isEditorOpen()
  );
}
// The poll asks for the workspace revision and an observation digest first. A
// board read follows only when the digest moved, so an idle board costs two
// indexed lookups instead of a full board load every fifteen seconds.
async function pollObservations() {
  const current = requireBoard(),
    path = state.root,
    signal = workspaceSignal();
  try {
    const revisionState = await api(`${path}/revision`, { signal });
    if (signal.aborted || state.board !== current || pollBlocked()) return;
    if (
      !revisionState ||
      !Number.isSafeInteger(revisionState.revision) ||
      typeof revisionState.role !== 'string'
    )
      throw new Error('Workspace state response is invalid.');
    if (
      revisionState.revision !== current.workspace.revision ||
      revisionState.role !== current.role
    ) {
      showPlanningChangeNotice(
        revisionState.role !== current.role
          ? 'Workspace permissions changed elsewhere · Refresh to review'
          : undefined,
      );
      return;
    }
    const digest = String(revisionState.links_digest || '');
    if (
      observationDigest &&
      digest === observationDigest &&
      Date.now() - observationReadAt < OBSERVATION_FALLBACK_MS
    )
      return;
    /** @type {Flux.Board} */
    const next = await api(`${path}/board`, { signal });
    if (signal.aborted || state.board !== current || pollBlocked()) return;
    if (!next?.workspace || !Array.isArray(next.links))
      throw new Error('Observation response is invalid.');
    if (next.workspace.revision !== current.workspace.revision || next.role !== current.role) {
      showPlanningChangeNotice(
        next.role !== current.role
          ? 'Workspace permissions changed elsewhere · Refresh to review'
          : undefined,
      );
      return;
    }
    const currentLinks = new Map(current.links.map((link) => [link.id, link]));
    if (
      next.links.length !== current.links.length ||
      next.links.some((link) => {
        const previous = currentLinks.get(link.id);
        return !previous || linkIdentitySignature(previous) !== linkIdentitySignature(link);
      })
    ) {
      showPlanningChangeNotice();
      return;
    }
    observationDigest = digest;
    observationReadAt = Date.now();
    if (observationsChanged(current.links, next.links))
      setState({
        board: { ...current, links: mergeEntities(current.links, next.links, (link) => link.id) },
      });
  } catch {
    if (
      !signal.aborted &&
      state.board === current &&
      !state.busy &&
      !state.integrationFormOpen &&
      !isEditorOpen()
    )
      notice('Observation cache could not be reloaded. Use Refresh to retry.', true);
  }
}
async function pollMembership() {
  const current = requireBoard(),
    selectedID = current.workspace.id,
    before = workspaceListSignature(state.workspaces),
    signal = workspaceSignal();
  try {
    const next = await loadWorkspaces(signal);
    if (
      signal.aborted ||
      state.board !== current ||
      state.busy ||
      state.loading ||
      state.integrationFormOpen ||
      document.hidden
    )
      return;
    if (!next.some((workspace) => workspace.id === selectedID)) {
      enterWorkspaceGate(
        next.length ? 'select' : 'create',
        next.length
          ? 'Workspace access changed. Choose an available workspace.'
          : 'Workspace access changed. Create a workspace to get started.',
      );
      return;
    }
    if (workspaceListSignature(next) !== before)
      showPlanningChangeNotice('Workspace membership changed · Refresh to review');
  } catch {
    if (!signal.aborted && state.board === current && !state.busy && !state.integrationFormOpen)
      notice('Workspace access could not be reloaded. Use Refresh to retry.', true);
  }
}
// The background polls run for the lifetime of the App.
export function usePolling() {
  useEffect(() => {
    let observing = false;
    let checkingMembership = false;
    const observations = setInterval(async () => {
      if (!state.board?.refresh_seconds || document.hidden || pollBlocked() || observing) return;
      observing = true;
      try {
        await pollObservations();
      } finally {
        observing = false;
      }
    }, 15000);
    const membership = setInterval(async () => {
      if (!state.board || document.hidden || pollBlocked() || checkingMembership) return;
      checkingMembership = true;
      try {
        await pollMembership();
      } finally {
        checkingMembership = false;
      }
    }, 30000);
    return () => {
      clearInterval(observations);
      clearInterval(membership);
    };
  }, []);
}
