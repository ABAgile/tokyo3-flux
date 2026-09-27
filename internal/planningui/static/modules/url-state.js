// Workspace, filter and open-card state kept in the address bar.
import { $ } from './dom.js';
import { api } from './api.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { notice } from './notices.js';
import {
  FILTER_NAMES,
  filterValues,
  setFilterValues,
  singleFilterValue,
  knownFilterValue,
} from './filters.js';
import { closeEditor } from './dialog.js';

function workspaceURLState() {
  return new URL(window.location.href).searchParams.get('workspace') || '';
}
export function workspacePreference() {
  return workspaceURLState() || localStorage.getItem('flux-plan-workspace') || '';
}
export function persistWorkspaceURL(id) {
  const url = new URL(window.location.href);
  if (id) {
    url.searchParams.set('workspace', id);
    localStorage.setItem('flux-plan-workspace', id);
  }
  // Leaving a workspace leaves its cards: a card link without a workspace names
  // nothing, so the open-card state goes with it.
  else {
    url.searchParams.delete('workspace');
    url.searchParams.delete('item');
    state.sharedItemID = '';
    state.editorItemID = '';
    localStorage.removeItem('flux-plan-workspace');
  }
  window.history.replaceState(null, '', url);
}
export function planningURLState() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  return {
    mode: mode === 'list' || mode === 'board' ? mode : undefined,
    project: params.get('project') || undefined,
    assignee: params.get('assignee') || undefined,
    label: params.get('label') || undefined,
    scope: params.get('scope') || undefined,
    item: params.get('item') || undefined,
  };
}
// Filters serialize as comma-separated values so a multi-value planning view
// stays shareable as a URL.
function filterURLValue(name) {
  const values = filterValues(name);
  return values.length ? values.join(',') : 'all';
}
export function persistPlanningURL({ push = false } = {}) {
  if (!state.board) return;
  const url = new URL(window.location.href);
  url.searchParams.set('mode', state.presentation);
  FILTER_NAMES.forEach((name) => url.searchParams.set(name, filterURLValue(name)));
  url.searchParams.set('scope', state.scope || 'active');
  if (state.sharedItemID) url.searchParams.set('item', state.sharedItemID);
  else url.searchParams.delete('item');
  if (url.href === window.location.href) return;
  if (push) window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}
// Opening and closing a card is a navigation, so it gets its own history entry
// and Back/Forward move between the board and the open card. Switching directly
// from one card to another closes and opens within the same task; the update is
// coalesced into one entry so Back does not stop at an intermediate state.
export function setSharedItem(id) {
  const next = String(id || '');
  if (next === state.sharedItemID) return;
  state.sharedItemID = next;
  if (state.sharedItemSync) return;
  state.sharedItemSync = true;
  queueMicrotask(() => {
    state.sharedItemSync = false;
    if ((new URL(window.location.href).searchParams.get('item') || '') !== state.sharedItemID)
      persistPlanningURL({ push: true });
  });
}
// A shared link carries only the workspace and the card. Filters are deliberately
// dropped: a reader must never receive a link whose active scope hides the very
// card it points at.
function cardShareURL(itemID) {
  const url = new URL(window.location.href);
  url.hash = '';
  url.search = '';
  url.searchParams.set('workspace', state.board.workspace.id);
  url.searchParams.set('item', itemID);
  return url.href;
}
// The outcome is shown on the control itself as well as announced, so a pointer
// user who never reads the status line still sees that the copy happened. The
// cue is a state swap rather than an animation, so reduced motion needs nothing.
const COPY_FEEDBACK_MS = 2000;
function markCopyOutcome(control, ok) {
  if (!control?.isConnected) return;
  const label = control.dataset.copyLabel || control.textContent;
  control.dataset.copyLabel = label;
  control.textContent = ok ? '\u2713 Link copied' : '! Not copied';
  control.classList.add(ok ? 'is-copied' : 'is-copy-failed');
  setTimeout(() => {
    if (!control.isConnected) return;
    control.textContent = label;
    control.classList.remove('is-copied', 'is-copy-failed');
  }, COPY_FEEDBACK_MS);
}
export async function copyCardLink(item, control) {
  const link = cardShareURL(item.id);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(link);
    markCopyOutcome(control, true);
    notice(`Link to \u201c${item.title}\u201d copied to the clipboard.`);
  } catch {
    markCopyOutcome(control, false);
    notice(
      `Card link could not be copied automatically. Copy it from the address bar or use ${link}`,
      true,
    );
  }
}
// A card link resolves against the board first and falls back to the single-card
// read, which answers for archived cards too. Archive pages are never walked:
// the card is found by identity regardless of how much history exists.
async function resolveSharedItem(itemID) {
  const local = state.board.items.find((value) => value.id === itemID);
  if (local) return local;
  const current = state.board,
    path = state.root;
  let response;
  try {
    response = await api(`${path}/items/${encodeURIComponent(itemID)}`);
  } catch {
    return undefined;
  }
  if (state.board !== current || state.root !== path) return undefined;
  return response?.item?.id === itemID ? response.item : undefined;
}
export async function openSharedItem(itemID) {
  if (!state.board || !itemID) return false;
  if (state.detailState?.itemID === itemID || (state.editorItemID === itemID && $('editor').open))
    return true;
  const item = await resolveSharedItem(itemID);
  if (!item) {
    setSharedItem('');
    notice('Card not found or no longer available.', true);
    return false;
  }
  if (state.view === 'board' && state.presentation === 'list' && state.detailPane) {
    if (!hooks.closeDetail({ focus: false })) return false;
    state.selectedItemID = item.id;
    hooks.openItemDetail(item);
  } else hooks.editItemModal(item);
  return true;
}
// Back/Forward restores the whole planning URL, including which card is open.
// Unsaved editor input is protected first: a refused close leaves the view and
// the address bar exactly as they were.
export async function applyHistoryNavigation() {
  const urlState = planningURLState();
  const workspace = workspaceURLState();
  if (state.board && workspace && workspace !== state.board.workspace.id) {
    state.pendingPlanningURLState = urlState;
    await hooks.chooseWorkspace(workspace);
    return;
  }
  if (!state.board) return;
  const target = String(urlState.item || '');
  if (
    state.detailState &&
    state.detailState.itemID !== target &&
    !hooks.closeDetail({ focus: false })
  ) {
    state.sharedItemID = state.detailState.itemID;
    persistPlanningURL();
    return;
  }
  if ($('editor').open && state.editorItemID !== target && !state.busy) closeEditor();
  applyPlanningURLState(urlState);
}
export function applyPlanningURLState(urlState = planningURLState()) {
  if (!state.board) return;
  FILTER_NAMES.forEach((name) =>
    setFilterValues(
      name,
      String(urlState[name] || '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value && value !== 'all' && knownFilterValue(name, value)),
    ),
  );
  const project = singleFilterValue('project');
  state.presentation =
    urlState.mode === 'list' || (!urlState.mode && project !== 'all' && project !== 'none')
      ? 'list'
      : 'board';
  const requestedScope = urlState.scope;
  const validScope =
    requestedScope &&
    (['active', 'backlog', 'all'].includes(requestedScope) ||
      state.board.sprints.some((value) => value.id === requestedScope));
  state.scope = validScope
    ? requestedScope
    : project !== 'all' && project !== 'none'
      ? 'all'
      : 'active';
  // The requested card is kept in the URL while it resolves, so a reload of a
  // shared link never drops the card it names before the details open.
  state.sharedItemID = String(urlState.item || '');
  hooks.render();
  persistPlanningURL();
  if (state.sharedItemID) void openSharedItem(state.sharedItemID);
}
