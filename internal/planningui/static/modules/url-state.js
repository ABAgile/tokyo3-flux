// Workspace, filter and open-card state kept in the address bar.
import { api } from './api.js';
import { useLayoutEffect } from './vendor-preact.js';
import { shallowEqual } from './vdom.js';
import { setState, state, useStore } from './state.js';
import { notice } from './notices.js';
import { FILTER_NAMES, knownFilterValue, singleFilterValue, withFilterValue } from './filters.js';

export function workspaceURLState() {
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
    setState({ sharedItemID: '', editorItemID: '' });
    localStorage.removeItem('flux-plan-workspace');
  }
  window.history.replaceState(null, '', url);
}
/** @returns {Flux.PlanningURLState} */
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
// The store patch that applies a planning URL to the loaded board. Unknown
// filter values and scopes are dropped; the requested card is kept while it
// resolves, so a reload of a shared link never drops the card it names.
/**
 * @param {Flux.PlanningURLState} urlState
 * @param {Flux.Board} board
 * @returns {Partial<Flux.State>}
 */
export function planningPatchFromURL(urlState, board) {
  const filters = /** @type {Flux.Filters} */ (
    Object.fromEntries(
      FILTER_NAMES.map((name) => [
        name,
        String(urlState[name] || '')
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value && value !== 'all' && knownFilterValue(name, value, board))
          .reduce(withFilterValue, []),
      ]),
    )
  );
  const project = singleFilterValue('project', filters);
  const lens = project !== 'all' && project !== 'none';
  const requestedScope = urlState.scope;
  const validScope =
    requestedScope &&
    (['active', 'backlog', 'all'].includes(requestedScope) ||
      board.sprints.some((value) => value.id === requestedScope));
  return {
    filters,
    presentation: urlState.mode === 'list' || (!urlState.mode && lens) ? 'list' : 'board',
    scope: validScope ? requestedScope : lens ? 'all' : 'active',
    sharedItemID: String(urlState.item || ''),
    planningURLReady: true,
  };
}
// Filters serialize as comma-separated values so a multi-value planning view
// stays shareable as a URL.
function planningURL(current) {
  const url = new URL(window.location.href);
  url.searchParams.set('mode', current.presentation);
  FILTER_NAMES.forEach((name) => {
    const values = current.filters[name];
    url.searchParams.set(name, values.length ? values.join(',') : 'all');
  });
  url.searchParams.set('scope', current.scope || 'active');
  if (current.sharedItemID) url.searchParams.set('item', current.sharedItemID);
  else url.searchParams.delete('item');
  return url;
}
// A refused Back/Forward leaves the state as it was; this puts its URL back.
export function restorePlanningURL() {
  if (state.board && state.planningURLReady)
    window.history.replaceState(null, '', planningURL(state));
}
// Opening and closing a card is a navigation, so it gets its own history entry
// and Back/Forward move between the board and the open card. Switching directly
// from one card to another closes and opens within the same task; the URL
// effect sees only the final card, so Back does not stop at an intermediate state.
let pushSharedItem = false;
export function setSharedItem(id) {
  const next = String(id || '');
  if (next === state.sharedItemID) return;
  pushSharedItem = true;
  setState({ sharedItemID: next });
}
function selectPlanningURL(current) {
  return {
    ready: !!current.board && current.planningURLReady,
    presentation: current.presentation,
    filters: current.filters,
    scope: current.scope,
    sharedItemID: current.sharedItemID,
  };
}
// The one writer of planning URL parameters: every URL-relevant state change
// replaces the current entry, and a changed open card pushes a new one.
export function usePlanningURL() {
  const current = useStore(selectPlanningURL, shallowEqual);
  // A layout effect, so the address bar matches the view it was rendered with.
  useLayoutEffect(() => {
    const push = pushSharedItem;
    pushSharedItem = false;
    if (!current.ready) return;
    const url = planningURL(current);
    if (url.href === window.location.href) return;
    const itemChanged =
      (new URL(window.location.href).searchParams.get('item') || '') !== current.sharedItemID;
    if (push && itemChanged) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  }, [current]);
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
export async function copyCardLink(item) {
  const link = cardShareURL(item.id);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(link);
    notice(`Link to \u201c${item.title}\u201d copied to the clipboard.`);
    return true;
  } catch {
    notice(
      `Card link could not be copied automatically. Copy it from the address bar or use ${link}`,
      true,
    );
    return false;
  }
}
// A card link resolves against the board first and falls back to the single-card
// read, which answers for archived cards too. Archive pages are never walked:
// the card is found by identity regardless of how much history exists.
export async function resolveSharedItem(itemID, signal) {
  const local = state.board.items.find((value) => value.id === itemID);
  if (local) return local;
  let response;
  try {
    response = await api(`${state.root}/items/${encodeURIComponent(itemID)}`, { signal });
  } catch {
    return undefined;
  }
  if (signal.aborted || !state.board) return undefined;
  return response?.item?.id === itemID ? response.item : undefined;
}
