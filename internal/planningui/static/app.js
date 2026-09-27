import { $ } from './modules/dom.js';
import { api } from './modules/api.js';
import { html, nothing, render as renderTemplate } from './modules/preact.js';
import { state } from './modules/state.js';
import { hooks } from './modules/hooks.js';
import { writable } from './modules/permissions.js';
import { App } from './modules/app-shell.js';
import { notice, clearPlanningChangeNotice } from './modules/notices.js';
import { activeSprints } from './modules/items.js';
import { renderControls } from './modules/controls.js';
import { refreshDueDateBadges, scheduleOverdueRefresh } from './modules/due-dates.js';
import { setContentBusy } from './modules/mount.js';
import {
  FILTER_NAMES,
  filterValues,
  addFilterValue,
  setFilterValues,
  knownFilterValue,
  flushSearch,
  queueSearch,
  filteredItems,
  placeFilters,
  renderFilterChips,
  applyFilterChange,
} from './modules/filters.js';
import { resetBurndown } from './modules/view-burndown.js';
import { clearUndo, quick, runSequence } from './modules/commands.js';
import { isFileTransfer, initAttachmentTooltips } from './modules/item-attachments.js';
import { closeEditor } from './modules/dialog.js';
import { initObservationTooltips } from './modules/gitlab.js';
import {
  workspacePreference,
  persistWorkspaceURL,
  planningURLState,
  persistPlanningURL,
  setSharedItem,
  applyHistoryNavigation,
} from './modules/url-state.js';
import {
  editItem,
  itemEditorDraft,
  reopenItemEditor,
  editItemModal,
} from './modules/item-editor.js';
import { closeDetail, selectItem, openItemDetail } from './modules/item-detail.js';
import { renderProjectSummary, setupBoard } from './modules/view-board.js';
import { loadArchive } from './modules/view-archive.js';
import {
  renderSprintSummary,
  resetSprintHistory,
  loadSprintHistory,
} from './modules/view-sprints.js';
import { showProposals } from './modules/view-proposals.js';
import { loadHistory } from './modules/view-history.js';
import { initShortcuts } from './modules/shortcuts.js';
import {
  loadWorkspaces,
  showWorkspaceCreate,
  showWorkspaceSelection,
  createWorkspace,
  chooseWorkspace,
} from './modules/view-gate.js';
import { refresh, startPolling } from './modules/sync.js';
// Late-bound calls from feature modules back into the shell.
Object.assign(hooks, {
  chooseWorkspace,
  closeDetail,
  editItemModal,
  itemEditorDraft,
  openItemDetail,
  persistPlanningURL,
  placeFilters,
  refresh,
  render,
  renderContent,
  reopenItemEditor,
  resetBurndown,
  selectItem,
  setSharedItem,
});
async function runUndo() {
  const commands = state.undoOffer;
  clearUndo();
  if (!commands?.length || !state.board || !writable()) return;
  if (commands.length === 1) {
    await quick(commands[0]);
    return;
  }
  await runSequence('Undo', commands);
}
function renderApp() {
  renderTemplate(
    html`<${App}
      refresh=${refresh}
      onUndo=${runUndo}
      onThemeToggle=${toggleTheme}
      onWorkspaceCreate=${showWorkspaceCreate}
      onWorkspaceChoose=${chooseWorkspace}
      onWorkspaceSubmit=${createWorkspace}
      onWorkspaceBack=${showWorkspaceSelection}
      onWorkspaceChange=${handleWorkspaceChange}
      onView=${navigateView}
      onProposals=${() => showProposals()}
      onSetupBoard=${setupBoard}
      onNewItem=${() => editItem()}
      onPresentation=${setPresentation}
      onScopeChange=${changeScope}
      onFilterChange=${changeFilter}
      onSearchInput=${queueSearch}
      onSearchChange=${handleSearchChange}
      onSearchKeyDown=${handleSearchKeyDown}
      onShortcutClose=${closeShortcuts}
    />`,
    document.body,
  );
}
renderApp();
const theme =
  localStorage.getItem('flux-plan-theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = theme;
function updateThemeControl() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('theme').firstElementChild.textContent = dark ? '☀' : '☾';
  $('theme').title = dark ? 'Switch to light theme' : 'Switch to dark theme';
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('flux-plan-theme', next);
  updateThemeControl();
}
updateThemeControl();
window.addEventListener('popstate', () => {
  void applyHistoryNavigation();
});
state.pendingPlanningURLState = planningURLState();
document.addEventListener('dragover', (e) => {
  if (isFileTransfer(e.dataTransfer)) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (isFileTransfer(e.dataTransfer)) e.preventDefault();
});
function render() {
  renderControls();
  if (!state.board) {
    setContentBusy(state.workspaceGate === 'loading' || state.loading);
    $('project-summary').hidden = true;
    renderTemplate(nothing, $('project-summary'));
    // Both hosts are rendered by Preact, so they are cleared through Preact.
    renderTemplate(nothing, $('sprint-summary'));
    $('count').textContent = '';
    clearPlanningChangeNotice();
    $('filter-chips').hidden = true;
    renderTemplate(nothing, $('filter-chips'));
    placeFilters();
    renderApp();
    return;
  }
  // The selects choose one value at a time and reset; the chip row below the
  // toolbar carries the full multi-value filter state.
  const scopes = new Set([
    'active',
    'backlog',
    'all',
    ...state.board.sprints.map((sprint) => sprint.id),
  ]);
  if (!scopes.has(state.scope)) state.scope = 'active';
  FILTER_NAMES.forEach((name) =>
    setFilterValues(
      name,
      filterValues(name).filter((value) => knownFilterValue(name, value)),
    ),
  );
  $('search').placeholder = state.view === 'sprints' ? 'Find sprints…' : 'Find work…';
  const active = activeSprints();
  const selectedSprint = state.board.sprints.find((sprint) => sprint.id === state.scope);
  const summarySprints = selectedSprint?.state === 'closed' ? [selectedSprint] : active;
  $('sprint-summary').setAttribute(
    'aria-label',
    selectedSprint?.state === 'closed' ? `Closed sprint: ${selectedSprint.name}` : 'Active sprints',
  );
  renderProjectSummary();
  renderSprintSummary(state.view === 'board' ? summarySprints : []);
  $('scope-label').hidden = state.view !== 'board';
  $('label-filter').hidden = state.view === 'sprints' || state.view === 'history';
  $('search-filter').hidden = state.view === 'history';
  $('planning-filters').hidden = ['history', 'projects', 'labels', 'members'].includes(state.view);
  // Views that own a page layout host the filter bar themselves, below their
  // heading; everywhere else it stays in its slot above the content.
  if (state.view !== 'sprints') placeFilters();
  renderFilterChips();
  renderContent();
}
function renderContent() {
  if (state.board && ['board', 'archive'].includes(state.view)) {
    const items = filteredItems();
    $('count').textContent =
      state.view === 'archive'
        ? `${items.length} archived${state.archiveMore ? '+' : ''} · workspace revision ${state.board.workspace.revision}`
        : `${items.length} items · workspace revision ${state.board.workspace.revision}`;
  }
  renderApp();
}
initObservationTooltips();
initAttachmentTooltips();
document.addEventListener('pointerdown', (e) => {
  document.querySelectorAll('.attachment-actions[open],.card-attachments[open]').forEach((menu) => {
    if (!menu.contains(e.target)) menu.open = false;
  });
  const editor = $('editor');
  if (!editor.open || state.busy) return;
  const r = editor.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
    closeEditor();
});
function setPresentation(next) {
  if (
    !['board', 'list'].includes(next) ||
    next === state.presentation ||
    state.loading ||
    state.busy ||
    state.integrationFormOpen
  )
    return;
  if (state.detailState && !closeDetail({ focus: false })) return;
  state.presentation = next;
  state.bulkSelection.clear();
  render();
  persistPlanningURL();
}
// A closed item editor is no longer a view of that card. The check is deferred
// because closing one dialog to open another — archive, observations, restore —
// happens within the same task and must not drop the card from the URL.
function changeScope(event) {
  state.scope = event.currentTarget.value;
  render();
  persistPlanningURL();
}
// Each select adds one value and resets to its "all" entry, so it reads as an
// add-a-filter control while the chip row owns the active state.
function changeFilter(name, event) {
  addFilterValue(name, event.target.value);
  event.target.value = 'all';
  applyFilterChange(name);
}
function handleSearchChange() {
  if (flushSearch() && state.board) renderContent();
}
function handleSearchKeyDown(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  if (flushSearch() && state.board) renderContent();
}
function handleWorkspaceChange() {
  void chooseWorkspace();
}
function closeShortcuts() {
  $('shortcuts').close();
}
async function navigateView(view) {
  if (state.loading || state.busy || state.integrationFormOpen) return;
  if (
    state.view === 'board' &&
    view !== 'board' &&
    state.detailState &&
    !closeDetail({ focus: false })
  )
    return;
  state.view = view;
  state.bulkSelection.clear();
  if (view !== 'board') {
    renderProjectSummary();
    renderSprintSummary([]);
  }
  if (view === 'history') {
    try {
      await loadHistory(true);
    } catch (e) {
      notice(e.message, true);
    }
  }
  if (view === 'archive') {
    try {
      await loadArchive(true);
    } catch (e) {
      notice(e.message, true);
    }
  }
  if (view === 'sprints') {
    resetSprintHistory();
    try {
      await loadSprintHistory(true);
    } catch (e) {
      state.sprintHistoryError = e.message;
      notice(e.message, true);
    }
  }
  render();
}
initShortcuts();
startPolling();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshDueDateBadges();
});
scheduleOverdueRefresh();
renderControls();
(async () => {
  try {
    state.session = await api('/api/v2/session');
    const next = await loadWorkspaces();
    const preferred = workspacePreference();
    if (!next.length) {
      state.pendingPlanningURLState = undefined;
      state.workspaceGate = 'create';
      persistWorkspaceURL('');
      notice('No workspace yet. Create one to get started.');
      render();
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
    state.workspaceGate = 'select';
    notice('Choose a workspace to continue.');
    render();
  } catch (e) {
    notice(e.message, true);
    render();
  }
})();
