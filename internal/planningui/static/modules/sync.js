// Board refresh, merging and UI-state capture, plus the background polls.
import { $ } from './dom.js';
import { api, apiRevalidated } from './api.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import {
  notice,
  clearError,
  showPlanningChangeNotice,
  clearPlanningChangeNotice,
} from './notices.js';
import { renderControls } from './controls.js';
import { setContentBusy } from './mount.js';
import { resetBurndown } from './view-burndown.js';
import { linkIdentitySignature, patchRefreshControl, patchObservationUI } from './gitlab.js';
import { persistWorkspaceURL } from './url-state.js';
import { resetArchive, loadArchive } from './view-archive.js';
import { resetSprintHistory, loadSprintHistory } from './view-sprints.js';
import { loadHistory } from './view-history.js';
import {
  workspaceListSignature,
  loadWorkspaces,
  enterWorkspaceGate,
  refreshWorkspaceGate,
} from './view-gate.js';

function mergeEntities(previous = [], next = [], key) {
  const existing = new Map(previous.map((value) => [key(value), value]));
  return next.map((value) => {
    const current = existing.get(key(value));
    if (!current) return value;
    Object.keys(current).forEach((name) => {
      if (!(name in value)) delete current[name];
    });
    Object.assign(current, value);
    return current;
  });
}
function mergeBoardData(previous, next) {
  if (!previous) return next;
  return {
    ...next,
    projects: mergeEntities(previous.projects, next.projects, (value) => value.id),
    labels: mergeEntities(previous.labels, next.labels, (value) => value.name),
    columns: mergeEntities(previous.columns, next.columns, (value) => value.id),
    items: mergeEntities(previous.items, next.items, (value) => value.id),
    sprints: mergeEntities(previous.sprints, next.sprints, (value) => value.id),
    members: mergeEntities(previous.members, next.members, (value) => value.subject),
    links: mergeEntities(previous.links, next.links, (value) => value.id),
  };
}
function captureUIState() {
  const active = document.activeElement;
  const focus =
    active && active !== document.body && active !== document.documentElement
      ? { node: active, id: active.id, key: active.dataset?.focusKey }
      : undefined;
  const selection =
    active && 'selectionStart' in active && Number.isFinite(active.selectionStart)
      ? {
          start: active.selectionStart,
          end: active.selectionEnd,
          direction: active.selectionDirection,
        }
      : undefined;
  const scrollNodes = [
    document.querySelector('main'),
    $('content'),
    state.detailPane,
    state.detailState?.form?.querySelector('.item-detail-fields'),
    $('editor'),
    $('editor-form')?.querySelector('#fields'),
  ].filter((node, index, values) => node && values.indexOf(node) === index);
  const details = [...document.querySelectorAll('details')].map((node, index) => ({
    node,
    key: node.dataset.stateKey || `details:${index}`,
    open: node.open,
  }));
  return {
    focus,
    selection,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrollNodes: scrollNodes.map((node) => ({ node, left: node.scrollLeft, top: node.scrollTop })),
    details,
  };
}
function restoreUIState(state) {
  if (!state) return;
  state.scrollNodes.forEach(({ node, left, top }) => {
    if (node?.isConnected) {
      node.scrollLeft = left;
      node.scrollTop = top;
    }
  });
  state.details.forEach(({ node, key, open }) => {
    const target = node?.isConnected
      ? node
      : [...document.querySelectorAll('details')].find(
          (candidate) => candidate.dataset.stateKey === key,
        );
    if (target) target.open = open;
  });
  window.scrollTo(state.scrollX, state.scrollY);
  let target = state.focus?.node?.isConnected ? state.focus.node : undefined;
  if (!target && state.focus?.id) target = $(state.focus.id);
  if (!target && state.focus?.key)
    target = [...document.querySelectorAll('[data-focus-key]')].find(
      (candidate) => candidate.dataset.focusKey === state.focus.key,
    );
  if (!target) return;
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
  if (state.selection && 'selectionStart' in target) {
    try {
      target.setSelectionRange(
        state.selection.start,
        state.selection.end,
        state.selection.direction,
      );
    } catch {}
  }
}
// preloaded carries a board a write already returned, so a saved change is
// applied without a second board read. Membership is still reloaded, because a
// change receipt says nothing about workspace access.
export async function refresh(preloaded) {
  if (state.busy || state.integrationFormOpen) return false;
  if (!state.root) return refreshWorkspaceGate();
  const generation = ++state.loadGeneration;
  let uiState;
  state.loading = true;
  renderControls();
  setContentBusy(true);
  try {
    const memberships = await loadWorkspaces();
    if (generation !== state.loadGeneration) return false;
    const selectedID =
      state.board?.workspace?.id ||
      memberships.find(
        (workspace) => `/api/v2/workspaces/${encodeURIComponent(workspace.id)}` === state.root,
      )?.id ||
      $('workspace').value;
    if (!selectedID || !memberships.some((workspace) => workspace.id === selectedID)) {
      enterWorkspaceGate(
        memberships.length ? 'select' : 'create',
        memberships.length
          ? 'Workspace access changed. Choose an available workspace.'
          : 'Workspace access changed. Create a workspace to get started.',
      );
      return false;
    }
    const cached = state.board && state.boardETagRoot === state.root ? state.boardETag : '';
    const response =
      preloaded?.board?.workspace?.id === selectedID
        ? { modified: true, etag: preloaded.etag, data: preloaded.board }
        : await apiRevalidated(state.root + '/board', cached);
    if (generation !== state.loadGeneration) return false;
    state.boardETag = response.etag;
    state.boardETagRoot = state.root;
    // The revision belongs in the non-live count, not in the polite status line:
    // repeating it on every poll would re-announce an unchanged board.
    if (!response.modified) {
      clearPlanningChangeNotice();
      clearError();
      notice('Up to date.');
      return true;
    }
    const next = response.data;
    uiState = captureUIState();
    state.board = mergeBoardData(state.board, next);
    state.searchIndexGeneration++;
    state.workspaceGate = '';
    persistWorkspaceURL(state.board.workspace.id);
    clearPlanningChangeNotice();
    clearError();
    resetBurndown();
    state.history = [];
    state.historyBefore = 0;
    resetArchive();
    resetSprintHistory();
    state.observationDigest = '';
    state.observationReadAt = 0;
    if (state.view === 'history') await loadHistory(true);
    if (state.view === 'archive') await loadArchive(true);
    if (state.view === 'sprints') await loadSprintHistory(true);
    notice('Up to date.');
    return true;
  } catch (e) {
    if (generation === state.loadGeneration) notice(e.message, true);
    return false;
  } finally {
    if (generation === state.loadGeneration) {
      state.loading = false;
      hooks.render();
      restoreUIState(uiState || captureUIState());
      if (!state.burndownRequests.size) setContentBusy(false);
    }
  }
}
// A digest that only ever reports "unchanged" is indistinguishable from a
// working one, so the board is re-read on a timer regardless of the digest.
// This bounds staleness if the digest ever stops tracking the board payload.
const OBSERVATION_FALLBACK_MS = 120000;
// Starts the background polls; app.js calls this once at startup.
export function startPolling() {
  // The poll asks for the workspace revision and an observation digest first. A
  // board read follows only when the digest moved, so an idle board costs two
  // indexed lookups instead of a full board load every fifteen seconds.
  setInterval(async () => {
    if (
      !state.board?.refresh_seconds ||
      state.busy ||
      state.loading ||
      state.integrationFormOpen ||
      state.drag ||
      document.hidden ||
      $('editor').open ||
      state.observationPoll
    )
      return;
    const current = state.board,
      path = state.root;
    state.observationPoll = true;
    try {
      const revisionState = await api(path + '/revision');
      if (
        state.board !== current ||
        state.root !== path ||
        state.busy ||
        state.loading ||
        state.integrationFormOpen ||
        state.drag ||
        $('editor').open
      )
        return;
      if (
        !revisionState ||
        !Number.isSafeInteger(revisionState.revision) ||
        typeof revisionState.role !== 'string'
      )
        throw new Error('Workspace state response is invalid.');
      if (
        revisionState.revision !== state.board.workspace.revision ||
        revisionState.role !== state.board.role
      ) {
        showPlanningChangeNotice(
          revisionState.role !== state.board.role
            ? 'Workspace permissions changed elsewhere · Refresh to review'
            : undefined,
        );
        return;
      }
      const digest = String(revisionState.links_digest || '');
      if (
        state.observationDigest &&
        digest === state.observationDigest &&
        Date.now() - state.observationReadAt < OBSERVATION_FALLBACK_MS
      )
        return;
      const next = await api(path + '/board');
      if (
        state.board !== current ||
        state.root !== path ||
        state.busy ||
        state.loading ||
        state.integrationFormOpen ||
        state.drag ||
        $('editor').open
      )
        return;
      if (!next?.workspace || !Array.isArray(next.links))
        throw new Error('Observation response is invalid.');
      if (
        next.workspace.revision !== state.board.workspace.revision ||
        next.role !== state.board.role
      ) {
        showPlanningChangeNotice(
          next.role !== state.board.role
            ? 'Workspace permissions changed elsewhere · Refresh to review'
            : undefined,
        );
        return;
      }
      const currentLinks = new Map(state.board.links.map((link) => [link.id, link]));
      if (
        next.links.length !== state.board.links.length ||
        next.links.some((link) => {
          const current = currentLinks.get(link.id);
          return !current || linkIdentitySignature(current) !== linkIdentitySignature(link);
        })
      ) {
        showPlanningChangeNotice();
        return;
      }
      state.observationDigest = digest;
      state.observationReadAt = Date.now();
      const uiState = captureUIState();
      const previousLinks = state.board.links;
      state.board.links = next.links;
      if (patchObservationUI(previousLinks, state.board.links)) restoreUIState(uiState);
    } catch {
      if (state.board === current && !state.busy && !state.integrationFormOpen && !$('editor').open)
        notice('Observation cache could not be reloaded. Use Refresh to retry.', true);
    } finally {
      state.observationPoll = false;
    }
  }, 15000);
  setInterval(async () => {
    if (
      !state.board ||
      state.busy ||
      state.loading ||
      state.integrationFormOpen ||
      state.drag ||
      document.hidden ||
      $('editor').open ||
      state.membershipPoll
    )
      return;
    const current = state.board,
      selectedID = state.board.workspace.id,
      before = workspaceListSignature(state.workspaces);
    state.membershipPoll = true;
    try {
      const next = await loadWorkspaces();
      if (
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
      if (state.board === current && !state.busy && !state.integrationFormOpen)
        notice('Workspace access could not be reloaded. Use Refresh to retry.', true);
    } finally {
      state.membershipPoll = false;
    }
  }, 30000);
  // Local freshness/cooldowns require no additional network requests.
  setInterval(() => {
    if (!state.board) return;
    document.querySelectorAll('[data-refresh-link]').forEach((node) => {
      const link = state.board.links.find((l) => l.id === node.dataset.refreshLink);
      patchRefreshControl(node, link);
    });
  }, 10000);
}
