// The workspace gate, workspace list and creation, and the first-run checklist.
import { $ } from './dom.js';
import { html } from './vdom.js';
import { FirstRunChecklist } from './gate-components.js';
import { api, requestKey } from './api.js';
import { setState, state } from './state.js';
import { hooks } from './hooks.js';
import { notice, clearError, clearPlanningChangeNotice } from './notices.js';
import { renderControls } from './controls.js';
import { setContentBusy } from './mount.js';
import { projectFilters, clearFilterGroup, clearFilters, resetSearch } from './filters.js';
import { resetBurndown } from './view-burndown.js';
import { clearUndo } from './commands.js';
import { closeEditor } from './dialog.js';
import { persistWorkspaceURL, persistPlanningURL, applyPlanningURLState } from './url-state.js';
import { closeDetail } from './item-detail.js';
import { resetSprintHistory } from './view-sprints.js';
import { goToView } from './shortcuts.js';

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
export function workspaceListSignature(list) {
  return JSON.stringify(
    list.map((workspace) => [workspace.id, workspace.name, workspace.role, workspace.revision]),
  );
}
export async function loadWorkspaces() {
  const next = await api('/api/v2/workspaces');
  if (!validWorkspaceList(next)) throw new Error('Workspace list is invalid. Refresh to retry.');
  state.workspaces = next;
  return next;
}
export function enterWorkspaceGate(mode, message) {
  if (state.detailState) closeDetail({ force: true, focus: false });
  if ($('editor').open && !state.busy) closeEditor();
  clearUndo();
  state.bulkSelection.clear();
  state.board = undefined;
  state.root = undefined;
  state.boardETag = '';
  state.boardETagRoot = '';
  resetSprintHistory();
  state.workspaceGate = mode;
  state.pendingPlanningURLState = undefined;
  persistWorkspaceURL('');
  if (message) notice(message);
  hooks.render();
}
export async function refreshWorkspaceGate() {
  if (state.busy || state.loading || state.integrationFormOpen) return false;
  const generation = ++state.loadGeneration;
  state.loading = true;
  renderControls();
  setContentBusy(true);
  try {
    const next = await loadWorkspaces();
    if (generation !== state.loadGeneration) return false;
    if (next.length === 1) {
      state.loading = false;
      return await chooseWorkspace(next[0].id);
    }
    state.workspaceGate = next.length ? 'select' : 'create';
    if (!next.length) persistWorkspaceURL('');
    notice(
      next.length
        ? 'Choose a workspace to continue.'
        : 'No workspace yet. Create one to get started.',
    );
    return true;
  } catch (e) {
    if (generation === state.loadGeneration) notice(e.message, true);
    return false;
  } finally {
    if (generation === state.loadGeneration) {
      state.loading = false;
      hooks.render();
    }
  }
}
// A brand-new board shows a short setup path instead of empty columns, so the
// workspace-creation momentum carries into the first sprint and card.
export function FirstRunPage({ board, disabled }) {
  const steps = [
    {
      done: board.projects.length > 0,
      title: 'Create a project',
      help: 'Projects classify work items; they are optional but make filtering and the project lens useful.',
      action: 'Open Projects',
      run: () => goToView('projects'),
    },
    {
      done: board.sprints.length > 0,
      title: 'Create and start a sprint',
      help: 'Give the sprint a goal and a time box, then start it so the board can show active scope.',
      action: 'Open Sprints',
      run: () => goToView('sprints'),
    },
    {
      done: board.items.length > 0,
      title: 'Add your first work item',
      help: 'Every card belongs to a board column; sprints and projects can be added at any time.',
      action: '＋ New item',
      run: () => $('new-item').click(),
    },
  ];
  return html`<section class="panel first-run" data-content-view="first-run" aria-labelledby="first-run-heading">
    <${FirstRunChecklist} steps=${steps} disabled=${disabled} />
  </section>`;
}
export function showFirstRun() {
  return (
    state.view === 'board' &&
    state.board.role !== 'viewer' &&
    !state.board.items.length &&
    !state.board.sprints.length &&
    !state.searchQuery
  );
}
export function showWorkspaceSelection() {
  if (state.busy || state.loading) return;
  state.workspaceGate = 'select';
  hooks.render();
  document.querySelector('[data-workspace-choice]')?.focus();
}
export function showWorkspaceCreate() {
  if (state.busy || state.loading || state.integrationFormOpen) return;
  setState({
    workspaceCreateKey: '',
    workspaceCreateName: '',
    workspaceCreateDraft: '',
    workspaceCreateStatus: '',
    workspaceCreateStatusError: false,
  });
  if (state.board) {
    enterWorkspaceGate('create', 'Create a workspace to add another planning space.');
    return;
  }
  state.workspaceGate = 'create';
  hooks.render();
}
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
  if (state.workspaceCreateName !== name || !state.workspaceCreateKey) {
    setState({ workspaceCreateName: name, workspaceCreateKey: requestKey() });
  }
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
    if (!validWorkspaceList([created]))
      throw new Error('Workspace response is invalid. Refresh to retry.');
    const next = await loadWorkspaces();
    if (!next.some((workspace) => workspace.id === created.id))
      throw new Error('The new workspace is not available yet. Refresh to retry.');
    state.pendingPlanningURLState = undefined;
    if (!(await chooseWorkspace(created.id)))
      throw new Error('Workspace created, but its board could not be opened. Refresh to retry.');
    setState({
      workspaceCreateKey: '',
      workspaceCreateName: '',
      workspaceCreateDraft: '',
      workspaceCreateStatus: '',
      workspaceCreateStatusError: false,
    });
  } catch (error) {
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
export async function chooseWorkspace(workspaceID = '') {
  if (state.busy || state.loading) return false;
  if (state.detailState && !closeDetail({ focus: false })) {
    hooks.render();
    return false;
  }
  const selectedID = workspaceID || $('workspace').value;
  if (!state.workspaces.some((workspace) => workspace.id === selectedID)) return false;
  const urlState = state.pendingPlanningURLState;
  state.pendingPlanningURLState = undefined;
  state.integrationFormOpen = false;
  state.integrationCatalog = [];
  state.integrationCatalogLoaded = false;
  state.integrationCatalogError = '';
  state.integrationCatalogLoading = false;
  state.integrationCatalogRequest++;
  clearPlanningChangeNotice();
  clearUndo();
  clearError();
  state.bulkSelection.clear();
  state.board = undefined;
  state.workspaceGate = 'loading';
  resetBurndown();
  state.burndownExpanded.clear();
  resetSprintHistory();
  state.projectSearch = '';
  clearFilterGroup(projectFilters);
  clearFilters();
  state.scope = 'active';
  resetSearch();
  state.root = `/api/v2/workspaces/${encodeURIComponent(selectedID)}`;
  hooks.render();
  const refreshed = await hooks.refresh();
  if (!refreshed) {
    if (urlState && state.workspaceGate === 'loading') state.pendingPlanningURLState = urlState;
    return false;
  }
  state.workspaceGate = '';
  persistWorkspaceURL(selectedID);
  if (urlState) applyPlanningURLState(urlState);
  else persistPlanningURL();
  return true;
}
