import { $, el, button, options, field } from './modules/dom.js';
import { api, apiRevalidated, requestKey } from './modules/api.js';
import { workspaceLabel } from './modules/format.js';
import {
  contentRoot,
  panel,
  helpText,
  statusLine,
  setStatusText,
  emptyState,
} from './modules/layout.js';
import { state } from './modules/state.js';
import { hooks } from './modules/hooks.js';
import { writable, writeButton } from './modules/permissions.js';
import {
  notice,
  clearError,
  showPlanningChangeNotice,
  clearPlanningChangeNotice,
} from './modules/notices.js';
import { activeSprints, styleLabelOptions } from './modules/items.js';
import { renderControls } from './modules/controls.js';
import { memberName } from './modules/people.js';
import { patchNode } from './modules/reconcile.js';
import { refreshDueDateBadges, scheduleOverdueRefresh } from './modules/due-dates.js';
import { planningHost, pageHost, setContentBusy } from './modules/mount.js';
import {
  projectFilters,
  FILTER_NAMES,
  filterValues,
  addFilterValue,
  setFilterValues,
  clearFilterGroup,
  clearFilters,
  knownFilterValue,
  resetSearch,
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
import {
  linkIdentitySignature,
  patchRefreshControl,
  patchObservationUI,
  initObservationTooltips,
} from './modules/gitlab.js';
import {
  workspacePreference,
  persistWorkspaceURL,
  planningURLState,
  persistPlanningURL,
  setSharedItem,
  applyHistoryNavigation,
  applyPlanningURLState,
} from './modules/url-state.js';
import {
  editItem,
  itemEditorDraft,
  reopenItemEditor,
  editItemModal,
} from './modules/item-editor.js';
import { closeDetail, selectItem, openItemDetail } from './modules/item-detail.js';
import { renderProjectSummary, renderBoardContent, setupBoard } from './modules/view-board.js';
import { renderCardListContent, resetArchive, loadArchive } from './modules/view-archive.js';
import { renderListPresentationContent } from './modules/view-list.js';
import {
  renderSprintPage,
  renderSprintSummary,
  resetSprintHistory,
  loadSprintHistory,
} from './modules/view-sprints.js';
import { renderProjects } from './modules/view-projects.js';
import { renderLabels } from './modules/view-labels.js';
import { renderMembers } from './modules/view-members.js';
import { showProposals } from './modules/view-proposals.js';
import { loadHistory, renderHistory } from './modules/view-history.js';
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
});
const theme =
  localStorage.getItem('flux-plan-theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = theme;
function updateThemeControl() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('theme').firstElementChild.textContent = dark ? '☀' : '☾';
  $('theme').title = dark ? 'Switch to light theme' : 'Switch to dark theme';
}
$('theme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('flux-plan-theme', next);
  updateThemeControl();
};
updateThemeControl();
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
function workspaceListSignature(list) {
  return JSON.stringify(
    list.map((workspace) => [workspace.id, workspace.name, workspace.role, workspace.revision]),
  );
}
function updateWorkspaceOptions(selected = '') {
  const signature = workspaceListSignature(state.workspaces);
  const select = $('workspace');
  if (select.dataset.signature === signature && select.value === selected) return;
  options(
    select,
    state.workspaces.map((workspace) => [workspace.id, workspaceLabel(workspace)]),
    selected,
  );
  select.dataset.signature = signature;
}
async function loadWorkspaces(selected = '') {
  const next = await api('/api/v2/workspaces');
  if (!validWorkspaceList(next)) throw new Error('Workspace list is invalid. Refresh to retry.');
  state.workspaces = next;
  updateWorkspaceOptions(
    selected && state.workspaces.some((workspace) => workspace.id === selected) ? selected : '',
  );
  return next;
}
window.addEventListener('popstate', () => {
  void applyHistoryNavigation();
});
state.pendingPlanningURLState = planningURLState();
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
function enterWorkspaceGate(mode, message) {
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
  render();
}
async function refreshWorkspaceGate() {
  if (state.busy || state.loading || state.integrationFormOpen) return false;
  const generation = ++state.loadGeneration;
  state.loading = true;
  renderControls();
  setContentBusy(true);
  try {
    const next = await loadWorkspaces('');
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
      render();
    }
  }
}
// preloaded carries a board a write already returned, so a saved change is
// applied without a second board read. Membership is still reloaded, because a
// change receipt says nothing about workspace access.
async function refresh(preloaded) {
  if (state.busy || state.integrationFormOpen) return false;
  if (!state.root) return refreshWorkspaceGate();
  const generation = ++state.loadGeneration;
  let uiState;
  state.loading = true;
  renderControls();
  setContentBusy(true);
  try {
    const selectedID = state.board?.workspace?.id || $('workspace').value;
    const memberships = await loadWorkspaces(selectedID);
    if (generation !== state.loadGeneration) return false;
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
      render();
      restoreUIState(uiState || captureUIState());
      if (!state.burndownRequests.size) setContentBusy(false);
    }
  }
}
document.addEventListener('dragover', (e) => {
  if (isFileTransfer(e.dataTransfer)) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (isFileTransfer(e.dataTransfer)) e.preventDefault();
});
function renderWorkspaceSelection(content) {
  const gate = panel('workspace-gate');
  gate.setAttribute('aria-label', 'Choose a workspace');
  gate.append(
    helpText(
      'Select the workspace you want to open. You can switch workspaces from the sidebar after entering one.',
    ),
  );
  const list = el('div', undefined, 'workspace-choice-list');
  list.setAttribute('role', 'list');
  state.workspaces.forEach((workspace) => {
    const choice = button(
      '',
      () => {
        void chooseWorkspace(workspace.id);
      },
      'workspace-choice',
    );
    choice.dataset.workspaceChoice = workspace.id;
    choice.setAttribute('aria-label', `Open ${workspace.name}`);
    const copy = el('span', undefined, 'workspace-choice-copy');
    copy.append(el('strong', workspace.name), el('small', `${workspace.role} access`, 'muted'));
    choice.append(copy, el('span', 'Open →', 'workspace-choice-action'));
    list.append(choice);
  });
  gate.append(list);
  const actions = el('div', undefined, 'actions workspace-gate-actions');
  actions.append(button('Create a workspace', showWorkspaceCreate, 'primary'));
  gate.append(actions);
  content.append(gate);
}
function renderWorkspaceCreation(content) {
  const gate = panel('workspace-gate');
  gate.setAttribute('aria-label', 'Create a workspace');
  gate.append(
    helpText(
      state.session?.name
        ? `You are signed in as ${state.session.name}. Create a workspace to start planning; you will be its initial administrator.`
        : 'Create a workspace to start planning; your signed-in account will be its initial administrator.',
    ),
  );
  const form = el('form', undefined, 'workspace-create-form');
  const input = field(form, 'name', 'Workspace name');
  input.id = 'workspace-name';
  input.required = true;
  input.maxLength = 120;
  input.autocomplete = 'organization';
  input.placeholder = 'e.g. Team Alpha';
  const status = statusLine('workspace-create-status');
  status.dataset.workspaceCreateStatus = 'true';
  form.append(status);
  const actions = el('div', undefined, 'actions');
  const submit = button('Create workspace', undefined, 'primary');
  submit.type = 'submit';
  actions.append(submit);
  if (state.workspaces.length)
    actions.append(button('Back to workspace selection', showWorkspaceSelection));
  form.append(actions);
  form.addEventListener('submit', createWorkspace);
  gate.append(form);
  content.append(gate);
  input.focus();
}
function render() {
  renderControls();
  if (!state.board) {
    setContentBusy(state.workspaceGate === 'loading' || state.loading);
    $('project-summary').hidden = true;
    $('project-summary').replaceChildren();
    $('sprint-summary').replaceChildren();
    $('count').textContent = '';
    $('planning-change').hidden = true;
    $('filter-chips').hidden = true;
    $('filter-chips').replaceChildren();
    if (state.workspaceGate === 'select') {
      $('title').textContent = 'Choose a workspace';
      $('subtitle').textContent = 'Select a shared planning space to continue.';
      renderWorkspaceSelection(pageHost());
    } else if (state.workspaceGate === 'create') {
      $('title').textContent = state.workspaces.length
        ? 'Create a workspace'
        : 'Create your first workspace';
      $('subtitle').textContent = 'Set up a shared planning space for your team.';
      renderWorkspaceCreation(pageHost());
    } else {
      $('title').textContent = 'Loading planning data';
      $('subtitle').textContent = 'Checking workspace access…';
      pageHost().append(emptyState('Loading workspace access…'));
    }
    return;
  }
  // The selects choose one value at a time and reset; the chip row below the
  // toolbar carries the full multi-value filter state.
  options(
    $('project'),
    [
      ['all', 'All projects'],
      ['none', 'No project'],
      ...state.board.projects.map((p) => [p.id, p.name]),
    ],
    'all',
  );
  options(
    $('assignee'),
    [
      ['all', 'All assignees'],
      ['none', 'Unassigned'],
      ...state.board.members.map((m) => [m.subject, memberName(m.subject)]),
    ],
    'all',
  );
  options(
    $('label'),
    [
      ['all', 'All labels'],
      ['none', 'No labels'],
      ...state.board.labels.map((label) => [label.name, label.name]),
    ],
    'all',
  );
  styleLabelOptions($('label'));
  FILTER_NAMES.forEach((name) =>
    setFilterValues(
      name,
      filterValues(name).filter((value) => knownFilterValue(name, value)),
    ),
  );
  const titles = {
    board: state.presentation === 'list' ? 'Planning list' : 'Kanban board',
    sprints: 'Sprints',
    projects: 'Projects',
    labels: 'Labels',
    members: 'Members',
    archive: 'Archive',
    history: 'History',
  };
  const subtitles = {
    projects: 'Organize workspace projects and GitLab integration.',
    labels: 'Maintain labels used to classify work.',
    members: 'Manage workspace members, roles, and names.',
  };
  $('title').textContent = titles[state.view];
  $('subtitle').textContent =
    state.board.role === 'viewer'
      ? 'Read-only workspace access.'
      : subtitles[state.view] || 'Plan intentionally. Keep work moving.';
  $('search').placeholder = state.view === 'sprints' ? 'Find sprints…' : 'Find work…';
  document.querySelectorAll('[data-view]').forEach((b) => {
    if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const active = activeSprints();
  const selected = $('scope').value;
  options(
    $('scope'),
    [
      ['active', 'Active sprints'],
      ['backlog', 'Backlog'],
      ['all', 'All open work'],
      ...state.board.sprints.map((s) => [s.id, `${s.name} (${s.state})`]),
    ],
    selected,
  );
  if (!$('scope').value) $('scope').value = 'active';
  const selectedSprint = state.board.sprints.find((s) => s.id === $('scope').value);
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
// A brand-new board shows a short setup path instead of empty columns, so the
// workspace-creation momentum carries into the first sprint and card.
function firstRunChecklist() {
  const steps = [
    {
      done: state.board.projects.length > 0,
      title: 'Create a project',
      help: 'Projects classify work items; they are optional but make filtering and the project lens useful.',
      action: 'Open Projects',
      run: () => goToView('projects'),
    },
    {
      done: state.board.sprints.length > 0,
      title: 'Create and start a sprint',
      help: 'Give the sprint a goal and a time box, then start it so the board can show active scope.',
      action: 'Open Sprints',
      run: () => goToView('sprints'),
    },
    {
      done: state.board.items.length > 0,
      title: 'Add your first work item',
      help: 'Every card belongs to a board column; sprints and projects can be added at any time.',
      action: '＋ New item',
      run: () => $('new-item').click(),
    },
  ];
  const setup = contentRoot('section', 'panel first-run', 'first-run');
  setup.setAttribute('aria-labelledby', 'first-run-heading');
  const heading = el('h2', 'Set up your planning workspace');
  heading.id = 'first-run-heading';
  setup.append(
    heading,
    helpText(
      'Three steps get this workspace to a board your team can use. You can do them in any order.',
    ),
  );
  const list = el('ol', undefined, 'first-run-steps');
  steps.forEach((step, index) => {
    const entry = el('li', undefined, `first-run-step${step.done ? ' is-done' : ''}`);
    const mark = el('span', step.done ? '✓' : String(index + 1), 'first-run-mark');
    mark.setAttribute('aria-hidden', 'true');
    const copy = el('div', undefined, 'first-run-copy');
    copy.append(el('strong', step.title), el('span', step.help, 'help'));
    const action = writeButton(step.action, step.run, step.done ? undefined : 'primary');
    action.setAttribute('aria-label', `${step.action}: ${step.title}`);
    entry.append(mark, copy, action);
    entry.setAttribute('aria-label', `${step.title} — ${step.done ? 'done' : 'not started'}`);
    list.append(entry);
  });
  setup.append(list);
  setup.dataset.renderSignature = JSON.stringify(steps.map((step) => step.done));
  return setup;
}
function showFirstRun() {
  return (
    state.view === 'board' &&
    state.board.role !== 'viewer' &&
    !state.board.items.length &&
    !state.board.sprints.length &&
    !state.searchQuery
  );
}
// Views that own their layout share one lifecycle: mount `#page-root`, keep the
// root the view patches in place (if it has one), then build into the host.
const PAGE_VIEWS = Object.freeze({
  projects: { build: renderProjects },
  sprints: { build: renderSprintPage, patches: 'sprint-page' },
  members: { build: renderMembers },
  labels: { build: renderLabels },
  history: { build: renderHistory },
});
function renderPageRoot(name) {
  if (!Object.hasOwn(PAGE_VIEWS, name)) return false;
  const page = PAGE_VIEWS[name];
  page.build(pageHost(page.patches || ''));
  return true;
}
function renderContent() {
  if (!state.board) return;
  if (renderPageRoot(state.view)) return;
  const body = planningHost();
  const items = filteredItems();
  $('count').textContent =
    state.view === 'archive'
      ? `${items.length} archived${state.archiveMore ? '+' : ''} · workspace revision ${state.board.workspace.revision}`
      : `${items.length} items · workspace revision ${state.board.workspace.revision}`;
  if (showFirstRun()) {
    const next = firstRunChecklist();
    const current = body.firstElementChild;
    if (!current || current.dataset.contentView !== 'first-run') body.replaceChildren(next);
    else patchNode(current, next);
    return;
  }
  if (state.view === 'board' && state.presentation === 'list')
    renderListPresentationContent(body, items);
  else if (state.view === 'board') renderBoardContent(body, items);
  else renderCardListContent(body, items);
  body.querySelector(':scope > .archive-more')?.remove();
  if (state.view === 'archive' && state.archiveMore) {
    const more = button(
      'Load older archived work',
      async () => {
        try {
          await loadArchive();
          renderContent();
        } catch (e) {
          notice(e.message, true);
        }
      },
      'archive-more',
    );
    more.disabled = state.busy || state.loading;
    body.append(more);
  }
}
function showWorkspaceSelection() {
  if (state.busy || state.loading) return;
  state.workspaceGate = 'select';
  render();
  document.querySelector('[data-workspace-choice]')?.focus();
}
function showWorkspaceCreate() {
  if (state.busy || state.loading || state.integrationFormOpen) return;
  state.workspaceCreateKey = '';
  state.workspaceCreateName = '';
  if (state.board) {
    enterWorkspaceGate('create', 'Create a workspace to add another planning space.');
    return;
  }
  state.workspaceGate = 'create';
  render();
}
async function createWorkspace(event) {
  event.preventDefault();
  if (state.workspaceCreating || state.busy || state.loading) return;
  const form = event.currentTarget;
  const input = form.elements.name;
  const status = form.querySelector('[data-workspace-create-status]');
  const submit = form.querySelector('button[type="submit"]');
  const name = String(input.value || '').trim();
  const setStatus = (text, error = false) => setStatusText(status, text, error);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL and line breaks are rejected on purpose.
  if (!name || name.length > 120 || /[\u0000\r\n]/.test(name)) {
    setStatus('Workspace name must be between 1 and 120 characters.', true);
    input.focus();
    return;
  }
  if (state.workspaceCreateName !== name || !state.workspaceCreateKey) {
    state.workspaceCreateName = name;
    state.workspaceCreateKey = requestKey();
  }
  state.workspaceCreating = true;
  submit.disabled = true;
  input.disabled = true;
  setStatus('Creating workspace…');
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
    const next = await loadWorkspaces(created.id);
    if (!next.some((workspace) => workspace.id === created.id))
      throw new Error('The new workspace is not available yet. Refresh to retry.');
    state.pendingPlanningURLState = undefined;
    if (!(await chooseWorkspace(created.id)))
      throw new Error('Workspace created, but its board could not be opened. Refresh to retry.');
    state.workspaceCreateKey = '';
    state.workspaceCreateName = '';
  } catch (error) {
    if (!document.querySelector('[data-workspace-create-status]')) {
      state.workspaceGate = 'create';
      state.root = undefined;
      render();
    }
    const currentForm = document.querySelector('.workspace-create-form');
    const currentStatus = currentForm?.querySelector('[data-workspace-create-status]');
    const currentInput = currentForm?.elements.name;
    if (currentInput && !currentInput.value) currentInput.value = state.workspaceCreateName || name;
    if (currentStatus) setStatusText(currentStatus, error.message, true);
    if (currentInput) currentInput.focus();
  } finally {
    state.workspaceCreating = false;
    const currentForm = document.querySelector('.workspace-create-form');
    if (currentForm) {
      currentForm.elements.name.disabled = false;
      currentForm.querySelector('button[type="submit"]').disabled = false;
    }
    renderControls();
  }
}
$('editor').addEventListener('cancel', (e) => {
  e.preventDefault();
  if (e.target === $('editor') && !state.busy) closeEditor();
});
$('editor').addEventListener('click', (e) => {
  if (!state.busy && e.target === $('editor')) closeEditor();
});
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
$('dismiss').onclick = $('cancel').onclick = () => {
  if (!state.busy) closeEditor();
};
// A closed item editor is no longer a view of that card. The check is deferred
// because closing one dialog to open another — archive, observations, restore —
// happens within the same task and must not drop the card from the URL.
$('editor').addEventListener('close', () => {
  setTimeout(() => {
    if ($('editor').open || state.detailState) return;
    state.editorItemID = '';
    setSharedItem('');
  }, 0);
});
$('proposals').onclick = () => showProposals();
$('new-item').onclick = () => editItem();
$('columns').onclick = setupBoard;
$('new-workspace').onclick = showWorkspaceCreate;
$('refresh').onclick = refresh;
$('planning-refresh').onclick = refresh;
$('presentation-board').onclick = () => setPresentation('board');
$('presentation-list').onclick = () => setPresentation('list');
$('scope').onchange = () => {
  render();
  persistPlanningURL();
};
// Each select adds one value and resets to its "all" entry, so it reads as an
// add-a-filter control while the chip row owns the active state.
FILTER_NAMES.forEach((name) => {
  $(name).onchange = (event) => {
    addFilterValue(name, event.target.value);
    event.target.value = 'all';
    applyFilterChange(name);
  };
});
$('search').oninput = queueSearch;
$('search').onchange = () => {
  if (flushSearch() && state.board) renderContent();
};
$('search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (flushSearch() && state.board) renderContent();
  }
});
$('error-dismiss').onclick = clearError;
$('shortcuts-dismiss').onclick = $('shortcuts-close').onclick = () => $('shortcuts').close();
document.addEventListener('keydown', (event) => {
  if (
    event.key !== 'Escape' ||
    !state.detailState?.pane?.contains(event.target) ||
    $('editor').open
  )
    return;
  const menu = event.target.closest?.('.multi-select-menu');
  if (menu && !menu.hidden) return;
  if (closeDetail()) event.preventDefault();
  event.stopImmediatePropagation();
});
// Escape leaves a page-level control so shortcuts become available without
// reaching for the pointer. Focus moves to the main region rather than being
// dropped, and contexts that already own Escape — dialogs, the detail pane and
// open selection menus — keep their existing close behavior.
document.addEventListener('keydown', (event) => {
  if (
    event.key !== 'Escape' ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !(event.target instanceof Element)
  )
    return;
  const control = event.target.closest(
    'input,textarea,select,[contenteditable=""],[contenteditable="true"]',
  );
  if (
    !control ||
    control.closest('dialog') ||
    control.closest('.multi-select-menu') ||
    state.detailState?.pane?.contains(control)
  )
    return;
  event.preventDefault();
  control.blur();
  $('main').focus({ preventScroll: true });
});
// Global shortcuts never fire while typing, while a dialog is open, or with
// Alt/Control/Meta held, so they cannot shadow browser or assistive-technology
// keys. Letters are matched case-insensitively and Shift is allowed, so Caps
// Lock or a shifted key still activates them.
const VIEW_SHORTCUTS = Object.freeze({
  b: 'board',
  s: 'sprints',
  p: 'projects',
  m: 'members',
  l: 'labels',
  a: 'archive',
  h: 'history',
});
const SHORTCUT_CHORD_MS = 2500;
function typingTarget(target) {
  return (
    target instanceof Element &&
    target.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"]') !== null
  );
}
function goToView(next) {
  const control = document.querySelector(`[data-view="${next}"]`);
  if (control && !control.disabled) control.click();
}
function shortcutKey(event) {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}
document.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  if ($('shortcuts').open) {
    if (event.key === 'Escape') $('shortcuts').close();
    return;
  }
  if (typingTarget(event.target) || $('editor').open) return;
  // A modifier or lock key pressed on its own must not consume a pending chord,
  // so holding Shift between `g` and the view key still navigates.
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
  const key = shortcutKey(event);
  const chord = state.shortcutChord && Date.now() - state.shortcutChord < SHORTCUT_CHORD_MS;
  state.shortcutChord = 0;
  if (chord) {
    if (VIEW_SHORTCUTS[key]) {
      event.preventDefault();
      goToView(VIEW_SHORTCUTS[key]);
      return;
    }
    if (key !== 'g') {
      notice('No view for that key. Press g then b, s, p, m, l, a or h.');
      return;
    }
  }
  if (event.key === '?' || (event.shiftKey && key === '/')) {
    event.preventDefault();
    $('shortcuts').showModal();
    return;
  }
  if (key === '/') {
    event.preventDefault();
    if (!$('search-filter').hidden && !$('planning-filters').hidden) {
      $('search').focus();
      $('search').select();
    }
    return;
  }
  if (key === 'g') {
    state.shortcutChord = Date.now();
    notice('Go to… press b, s, p, m, l, a or h.');
    return;
  }
  if (key === 'n') {
    if (!$('new-item').disabled && !document.querySelector('.heading .actions').hidden) {
      event.preventDefault();
      $('new-item').click();
    }
    return;
  }
  if (key === 'r') {
    if (!$('refresh').disabled) {
      event.preventDefault();
      void refresh();
    }
  }
});
$('undo').onclick = async () => {
  const commands = state.undoOffer;
  clearUndo();
  if (!commands?.length || !state.board || !writable()) return;
  if (commands.length === 1) {
    await quick(commands[0]);
    return;
  }
  await runSequence('Undo', commands);
};
document.querySelectorAll('[data-view]').forEach((b) => {
  b.onclick = async () => {
    if (state.loading || state.busy || state.integrationFormOpen) return;
    if (
      state.view === 'board' &&
      b.dataset.view !== 'board' &&
      state.detailState &&
      !closeDetail({ focus: false })
    )
      return;
    state.view = b.dataset.view;
    state.bulkSelection.clear();
    if (state.view === 'history') {
      try {
        await loadHistory(true);
      } catch (e) {
        notice(e.message, true);
      }
    }
    if (state.view === 'archive') {
      try {
        await loadArchive(true);
      } catch (e) {
        notice(e.message, true);
      }
    }
    if (state.view === 'sprints') {
      resetSprintHistory();
      try {
        await loadSprintHistory(true);
      } catch (e) {
        state.sprintHistoryError = e.message;
        notice(e.message, true);
      }
    }
    render();
  };
});
async function chooseWorkspace(workspaceID = '') {
  if (state.busy || state.loading) return false;
  if (state.detailState && !closeDetail({ focus: false })) {
    if (state.board?.workspace?.id) $('workspace').value = state.board.workspace.id;
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
  updateWorkspaceOptions(selectedID);
  resetBurndown();
  state.burndownExpanded.clear();
  resetSprintHistory();
  state.projectSearch = '';
  clearFilterGroup(projectFilters);
  clearFilters();
  $('scope').value = 'active';
  resetSearch();
  state.root = `/api/v2/workspaces/${encodeURIComponent(selectedID)}`;
  render();
  const refreshed = await refresh();
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
$('workspace').onchange = () => {
  void chooseWorkspace();
};
// A digest that only ever reports "unchanged" is indistinguishable from a
// working one, so the board is re-read on a timer regardless of the digest.
// This bounds staleness if the digest ever stops tracking the board payload.
const OBSERVATION_FALLBACK_MS = 120000;
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
    const next = await loadWorkspaces(selectedID);
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
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshDueDateBadges();
});
scheduleOverdueRefresh();
renderControls();
(async () => {
  try {
    state.session = await api('/api/v2/session');
    $('identity').textContent = state.session.name || state.session.subject;
    const next = await loadWorkspaces('');
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
