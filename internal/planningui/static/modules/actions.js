// Named UI actions. Each action validates against the current state and makes
// one store update for everything it changes; components import them directly.
import { api, isAbortError, requestKey } from './api.js';
import { beginWorkspaceSession, workspaceSignal } from './workspace-session.js';
import { setState, state } from './state.js';
import { notice, clearError, clearUndo, clearPlanningChangeNotice } from './notices.js';
import { writable } from './permissions.js';
import { singleFilterValue } from './filters.js';
import { quick, runSequence } from './commands.js';
import { refresh, enterWorkspaceGate, beginLoad, finishLoad } from './sync.js';
import { closeEditor, isEditorOpen, openDialog } from './dialog-state.js';
import {
  EMPTY_SPRINT_HISTORY,
  loadWorkspaces,
  validWorkspace,
  viewPage,
  workspaceRoot,
} from './page-data.js';
import {
  persistWorkspaceURL,
  planningPatchFromURL,
  planningURLState,
  resolveSharedItem,
  restorePlanningURL,
  setSharedItem,
  workspacePreference,
  workspaceURLState,
} from './url-state.js';
import { focusRequestPatch } from './focus-request.js';

/** @type {Readonly<Flux.Filters>} */
const EMPTY_FILTERS = Object.freeze({ project: [], assignee: [], label: [] });
const EMPTY_PROJECT_FILTERS = Object.freeze({ assignee: [], label: [] });

// Navigation and presentation wait while a request is in flight or the
// integration form holds the page.
export function interactionBlocked() {
  return state.loading || state.busy || state.integrationFormOpen;
}
export function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('flux-plan-theme', next);
  setState({ theme: next });
}
export function refreshWorkspace() {
  return state.root ? refresh() : refreshWorkspaceGate();
}

// ── List detail ─────────────────────────────────────────────────────────────

function listPresentation() {
  return !!state.board && state.view === 'board' && state.presentation === 'list';
}
/**
 * @param {{ force?: boolean, focus?: boolean }} [options]
 * @returns {boolean}
 */
export function closeDetail({ force = false, focus = true } = {}) {
  if (state.busy) return false;
  const detail = state.detail;
  if (!detail) {
    setState({ selectedItemID: '', detailError: '' });
    return true;
  }
  if (
    !force &&
    detail.dirty &&
    !window.confirm(`Discard unsaved changes to “${detail.item?.title || 'this item'}”?`)
  )
    return false;
  // Focus returns to the row the details were opened from once the pane is gone.
  setState({
    detail: undefined,
    selectedItemID: '',
    detailError: '',
    ...(focus
      ? focusRequestPatch('list', detail.originFocusKey || `item:${detail.itemID}:list-row`)
      : {}),
  });
  setSharedItem('');
  return true;
}
function openItemDetail(item, draft, originFocusKey) {
  if (!listPresentation()) return;
  setState({
    selectedItemID: item.id,
    detailError: '',
    detail: {
      itemID: item.id,
      formKey: requestKey(),
      item,
      itemRevision: item.revision,
      draft,
      originFocusKey,
      dirty: false,
      focusNonce: 1,
    },
  });
  setSharedItem(item.id);
}
/**
 * @param {string} itemID
 * @param {string} [originFocusKey]
 * @returns {boolean}
 */
export function selectItem(itemID, originFocusKey) {
  if (!listPresentation()) return false;
  const detail = state.detail;
  if (detail?.itemID === itemID) {
    setState({
      detail: {
        ...detail,
        originFocusKey: originFocusKey || detail.originFocusKey,
        focusNonce: detail.focusNonce + 1,
      },
    });
    return true;
  }
  if (!closeDetail({ focus: false })) return false;
  const item = state.board.items.find((value) => value.id === itemID);
  if (!item) return false;
  openItemDetail(item, undefined, originFocusKey);
  return true;
}
/**
 * @param {string} formKey
 * @param {boolean} dirty
 */
export function setDetailDirty(formKey, dirty) {
  const detail = state.detail;
  if (detail?.formKey === formKey && detail.dirty !== dirty)
    setState({ detail: { ...detail, dirty } });
}

// ── Item editor ─────────────────────────────────────────────────────────────

function editItemModal(item, draft) {
  const existing = !!item;
  const readOnly = state.board.role === 'viewer' || !!item?.archived;
  const project = singleFilterValue('project', state.filters);
  const projectIDs = ['all', 'none'].includes(project) ? [] : [project];
  const snapshot = item || {
    title: '',
    description: '',
    start_date: '',
    end_date: '',
    due_date: '',
    column_id: state.board.columns[0].id,
    project_id: projectIDs[0] || '',
    project_ids: projectIDs,
    sprint_ids: [],
    assignee: '',
    labels: [],
    dependencies: [],
  };
  setState({ editorItemID: existing ? item.id : '' });
  if (existing) setSharedItem(item.id);
  openDialog('item.edit', { item: snapshot, draft, readOnly });
}
/**
 * @param {Flux.Item} [item]
 * @param {Flux.ItemDraft} [draft]
 */
export function editItem(item, draft) {
  if (item && listPresentation()) return selectItem(item.id);
  return editItemModal(item, draft);
}
export function newItem() {
  if (!writable() || state.integrationFormOpen) return;
  editItem();
}
// Reopens a card in the surface it was edited in, carrying the draft over.
/**
 * @param {Flux.Item} item
 * @param {Flux.ItemDraft | undefined} draft
 * @param {Flux.EditorMode} mode
 * @param {string} [originFocusKey]
 */
export function reopenItemEditor(item, draft, mode, originFocusKey) {
  if (mode === 'detail') openItemDetail(item, draft, originFocusKey);
  else editItemModal(item, draft);
}
/**
 * @param {string} itemID
 * @returns {Promise<boolean>}
 */
export async function openSharedItem(itemID) {
  if (!state.board || !itemID) return false;
  if (state.detail?.itemID === itemID || (state.editorItemID === itemID && isEditorOpen()))
    return true;
  const signal = workspaceSignal();
  const item = await resolveSharedItem(itemID, signal);
  if (signal.aborted) return false;
  if (!item) {
    setSharedItem('');
    notice('Card not found or no longer available.', true);
    return false;
  }
  if (listPresentation()) {
    if (!closeDetail({ focus: false })) return false;
    openItemDetail(item);
  } else editItemModal(item);
  return true;
}
export function showProposals() {
  if (!state.board || state.busy || state.loading) return;
  openDialog('proposals', { root: state.root });
}

// ── Views, presentation, scope and filters ──────────────────────────────────

/** @param {Flux.State['view']} view */
export async function navigate(view) {
  if (!state.board || interactionBlocked()) return;
  if (state.view === 'board' && view !== 'board' && state.detail && !closeDetail({ focus: false }))
    return;
  setState({
    view,
    bulkSelection: [],
    ...(view === 'sprints' ? EMPTY_SPRINT_HISTORY : {}),
  });
  if (!['history', 'archive', 'sprints'].includes(view)) return;
  const signal = workspaceSignal();
  try {
    const page = await viewPage(view, signal);
    if (!signal.aborted) setState(page);
  } catch (e) {
    if (signal.aborted || isAbortError(e)) return;
    if (view === 'sprints') setState({ sprintHistoryError: e.message });
    notice(e.message, true);
  }
}
/** @param {Flux.State['presentation']} next */
export function setPresentation(next) {
  if (!['board', 'list'].includes(next) || next === state.presentation || interactionBlocked())
    return;
  if (state.detail && !closeDetail({ focus: false })) return;
  setState({ presentation: next, bulkSelection: [] });
}
/** @param {string} scope */
export function setScope(scope) {
  setState({ scope });
}
/** @param {Flux.Project} project */
export function openProject(project) {
  if (!state.board || !project || interactionBlocked()) return;
  if (state.detail && !closeDetail({ focus: false })) return;
  setState({
    view: 'board',
    presentation: 'list',
    filters: { ...EMPTY_FILTERS, project: [project.id] },
    scope: 'all',
    searchInput: '',
    searchQuery: '',
  });
}
/** @param {Flux.Sprint} sprint */
export function viewSprintScope(sprint) {
  setState({ view: 'board', scope: sprint.id });
}
// Store lists of ids are arrays: plain data that compares, prints and
// serializes like the rest of the state.
/**
 * @param {readonly string[]} list
 * @param {string} id
 * @returns {string[]}
 */
export function toggled(list, id) {
  return list.includes(id) ? list.filter((value) => value !== id) : [...list, id];
}
/** @param {string} sprintID */
export function toggleBurndown(sprintID) {
  setState((current) => ({ burndownExpanded: toggled(current.burndownExpanded, sprintID) }));
}
/**
 * @param {string} itemID
 * @param {boolean} selected
 */
export function setBulkSelected(itemID, selected) {
  setState((current) => {
    if (current.bulkSelection.includes(itemID) === selected) return undefined;
    return { bulkSelection: toggled(current.bulkSelection, itemID) };
  });
}
/** @param {string[]} ids */
export function selectAllBulk(ids) {
  setState((current) => ({ bulkSelection: [...new Set([...current.bulkSelection, ...ids])] }));
}
export function clearBulk() {
  setState({ bulkSelection: [] });
}

// ── Undo ────────────────────────────────────────────────────────────────────

export async function runUndo() {
  const commands = state.undoOffer;
  clearUndo();
  if (!commands?.length || !state.board || !writable()) return;
  if (commands.length === 1) {
    await quick(commands[0]);
    return;
  }
  await runSequence('Undo', commands);
}

// ── Workspaces and URL navigation ───────────────────────────────────────────

function applyPlanningURLState(urlState = planningURLState()) {
  if (!state.board) return;
  const patch = planningPatchFromURL(urlState, state.board);
  setState(patch);
  if (patch.sharedItemID) void openSharedItem(patch.sharedItemID);
}
/**
 * @param {string} workspaceID
 * @returns {Promise<boolean>}
 */
export async function chooseWorkspace(workspaceID) {
  if (state.busy || state.loading) return false;
  if (state.detail && !closeDetail({ focus: false })) return false;
  const selectedID = String(workspaceID || '');
  if (!state.workspaces.some((workspace) => workspace.id === selectedID)) return false;
  const urlState = state.pendingPlanningURLState;
  // Work still running for the previous workspace is cancelled before the
  // new root is visible to anyone.
  beginWorkspaceSession();
  clearPlanningChangeNotice();
  clearUndo();
  clearError();
  setState({
    pendingPlanningURLState: undefined,
    planningURLReady: false,
    integrationFormOpen: false,
    integrationDraft: undefined,
    integrationConsent: false,
    integrationSubmitting: false,
    integrationFormError: '',
    bulkSelection: [],
    board: undefined,
    workspaceGate: 'loading',
    burndownExpanded: [],
    ...EMPTY_SPRINT_HISTORY,
    projectSearch: '',
    projectFilters: EMPTY_PROJECT_FILTERS,
    filters: EMPTY_FILTERS,
    scope: 'active',
    searchInput: '',
    searchQuery: '',
    attachmentLists: {},
    root: workspaceRoot(selectedID),
  });
  const refreshed = await refresh();
  if (!refreshed) {
    if (urlState && state.workspaceGate === 'loading')
      setState({ pendingPlanningURLState: urlState });
    return false;
  }
  setState({ workspaceGate: '' });
  persistWorkspaceURL(selectedID);
  if (urlState) applyPlanningURLState(urlState);
  else setState({ planningURLReady: true });
  return true;
}
async function refreshWorkspaceGate() {
  if (interactionBlocked()) return false;
  const load = beginLoad();
  try {
    const next = await loadWorkspaces(load.signal);
    if (load.signal.aborted) return false;
    if (next.length === 1) {
      finishLoad(load);
      return await chooseWorkspace(next[0].id);
    }
    setState({ workspaceGate: next.length ? 'select' : 'create' });
    if (!next.length) persistWorkspaceURL('');
    notice(
      next.length
        ? 'Choose a workspace to continue.'
        : 'No workspace yet. Create one to get started.',
    );
    return true;
  } catch (e) {
    if (!load.signal.aborted) notice(e.message, true);
    return false;
  } finally {
    finishLoad(load);
  }
}
// Back/Forward restores the whole planning URL, including which card is open.
// Unsaved editor input is protected first: a refused close leaves the view and
// the address bar exactly as they were.
export async function applyHistoryNavigation() {
  const urlState = planningURLState();
  const workspace = workspaceURLState();
  if (state.board && workspace && workspace !== state.board.workspace.id) {
    setState({ pendingPlanningURLState: urlState });
    await chooseWorkspace(workspace);
    return;
  }
  if (!state.board) return;
  const target = String(urlState.item || '');
  if (state.detail && state.detail.itemID !== target && !closeDetail({ focus: false })) {
    // The state did not change, so put the refused card back in the address bar.
    restorePlanningURL();
    return;
  }
  if (isEditorOpen() && state.editorItemID !== target && !state.busy) closeEditor();
  applyPlanningURLState(urlState);
}
const EMPTY_CREATE = {
  workspaceCreateKey: '',
  workspaceCreateName: '',
  workspaceCreateDraft: '',
  workspaceCreateStatus: '',
  workspaceCreateStatusError: false,
};
export function showWorkspaceSelection() {
  if (state.busy || state.loading) return;
  const first = state.workspaces[0];
  setState({
    workspaceGate: 'select',
    ...(first ? focusRequestPatch('workspaces', `workspace:${first.id}`) : {}),
  });
}
export function showWorkspaceCreate() {
  if (interactionBlocked()) return;
  setState(EMPTY_CREATE);
  if (state.board) {
    enterWorkspaceGate('create', 'Create a workspace to add another planning space.');
    return;
  }
  setState({ workspaceGate: 'create' });
}
/** @param {string} value */
export async function createWorkspace(value) {
  if (state.workspaceCreating || state.busy || state.loading) return;
  const name = String(value || '').trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL and line breaks are rejected on purpose.
  if (!name || name.length > 120 || /[\u0000\r\n]/.test(name)) {
    setState({
      workspaceCreateStatus: 'Workspace name must be between 1 and 120 characters.',
      workspaceCreateStatusError: true,
    });
    return;
  }
  if (state.workspaceCreateName !== name || !state.workspaceCreateKey)
    setState({ workspaceCreateName: name, workspaceCreateKey: requestKey() });
  setState({
    workspaceCreating: true,
    workspaceCreateStatus: 'Creating workspace…',
    workspaceCreateStatusError: false,
  });
  try {
    const created = await api('/api/v2/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': state.session.csrf,
        'Idempotency-Key': state.workspaceCreateKey,
      },
      body: JSON.stringify({ name }),
    });
    if (!validWorkspace(created))
      throw new Error('Workspace response is invalid. Refresh to retry.');
    const next = await loadWorkspaces();
    if (!next.some((workspace) => workspace.id === created.id))
      throw new Error('The new workspace is not available yet. Refresh to retry.');
    setState({ pendingPlanningURLState: undefined });
    if (!(await chooseWorkspace(created.id)))
      throw new Error('Workspace created, but its board could not be opened. Refresh to retry.');
    setState(EMPTY_CREATE);
  } catch (error) {
    beginWorkspaceSession();
    setState({
      workspaceGate: 'create',
      root: undefined,
      workspaceCreateStatus: error.message,
      workspaceCreateStatusError: true,
    });
  } finally {
    setState({ workspaceCreating: false });
  }
}
// Startup: the session, then the preferred or only workspace, or the gate.
export async function startApp() {
  setState({ pendingPlanningURLState: planningURLState() });
  try {
    setState({ session: await api('/api/v2/session') });
    const next = await loadWorkspaces();
    const preferred = workspacePreference();
    if (!next.length) {
      setState({ pendingPlanningURLState: undefined, workspaceGate: 'create' });
      persistWorkspaceURL('');
      notice('No workspace yet. Create one to get started.');
      return;
    }
    if (preferred && next.some((workspace) => workspace.id === preferred)) {
      await chooseWorkspace(preferred);
      return;
    }
    if (preferred) persistWorkspaceURL('');
    if (next.length === 1) {
      await chooseWorkspace(next[0].id);
      return;
    }
    setState({ workspaceGate: 'select' });
    notice('Choose a workspace to continue.');
  } catch (e) {
    notice(e.message, true);
  }
}
