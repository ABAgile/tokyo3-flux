import { $, el, button, options, svgNode, field, uid } from './modules/dom.js';
import { api, apiRevalidated, requestKey } from './modules/api.js';
import { workspaceLabel, workspaceHistoryLabel } from './modules/format.js';
import { renderMarkdown, markdownEditor } from './modules/markdown.js';
import {
  contentRoot,
  pageStack,
  panel,
  sectionHead,
  panelHead,
  helpText,
  statusLine,
  setStatusText,
  errorLine,
  setErrorText,
  emptyState,
  metricList,
  filterBar,
  filterSelect,
  filterSearch,
  filterChipRow,
  filterSlot,
  maintenanceList,
  maintenanceRow,
} from './modules/layout.js';
import { state } from './modules/state.js';
import { hooks } from './modules/hooks.js';
import {
  actionIconButton,
  writeIconButton,
  adminIconButton,
  writable,
  adminWritable,
  writeButton,
  adminButton,
} from './modules/permissions.js';
import {
  notice,
  clearError,
  showPlanningChangeNotice,
  clearPlanningChangeNotice,
} from './modules/notices.js';
import {
  activeSprints,
  itemProjectIDs,
  labelInfo,
  labelBadge,
  styleLabelOptions,
  done,
  blocked,
  scopeItems,
} from './modules/items.js';
import { renderControls } from './modules/controls.js';
import { memberName, memberListingInfo, avatarView } from './modules/people.js';
import { patchNode, keyedNodeKey, reconcileKeyedChildren } from './modules/reconcile.js';
import { multiSelect, labelColorPicker } from './modules/multi-select.js';
import { refreshDueDateBadges, scheduleOverdueRefresh } from './modules/due-dates.js';
import {
  gitlabProjectLabel,
  integrationProjectEntries,
  memberUserEntries,
  loadGitLabUsers,
  loadGitLabProjects,
} from './modules/gitlab-catalog.js';
import { planningHost, pageHost, pageRoot, setContentBusy } from './modules/mount.js';
import {
  PROJECT_FILTER_NAMES,
  projectFilters,
  FILTER_NAMES,
  filterValues,
  addFilterValue,
  setFilterValues,
  clearFilterGroup,
  clearFilters,
  matchesFilter,
  filterChipNodes,
  knownFilterValue,
  resetSearch,
  flushSearch,
  queueSearch,
  filteredItems,
  placeFilters,
  renderFilterChips,
  applyFilterChange,
  sprintFilterItems,
  sprintMatchesFilters,
} from './modules/filters.js';
import { resetBurndown, currentBurndownKey, renderBurndown } from './modules/view-burndown.js';
import { change, clearUndo, quick, runSequence } from './modules/commands.js';
import { isFileTransfer, initAttachmentTooltips } from './modules/item-attachments.js';
import { closeEditor, openEditor } from './modules/dialog.js';
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
const sprintGoalLayouts = new Map();
const sprintGoalResizeObserver = new ResizeObserver(() => {
  for (const [content, update] of sprintGoalLayouts) {
    if (!content.isConnected) {
      sprintGoalLayouts.delete(content);
      sprintGoalResizeObserver.unobserve(content);
    } else update();
  }
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
function sprintGoal(value) {
  const goal = el('div', undefined, 'sprint-goal');
  const content = el('div', undefined, 'sprint-goal-content');
  content.id = uid('sprint-goal');
  content.inert = true;
  renderMarkdown(content, value);
  let expanded = false;
  const updateDisclosure = () => {
    const clipped = content.scrollHeight > content.clientHeight + 1;
    toggle.hidden = !expanded && !clipped;
    content.inert = !expanded && clipped;
  };
  const toggle = button(
    'Show more',
    () => {
      expanded = !expanded;
      toggle.textContent = expanded ? 'Show less' : 'Show more';
      toggle.setAttribute('aria-expanded', String(expanded));
      content.classList.toggle('is-expanded', expanded);
      updateDisclosure();
    },
    'sprint-goal-toggle',
  );
  toggle.hidden = true;
  toggle.setAttribute('aria-controls', content.id);
  toggle.setAttribute('aria-expanded', 'false');
  goal.append(content, toggle);
  requestAnimationFrame(() => {
    if (!content.isConnected) return;
    updateDisclosure();
    sprintGoalLayouts.set(content, updateDisclosure);
    sprintGoalResizeObserver.observe(content);
  });
  return goal;
}
function sprintPanel(s, items = scopeItems(s)) {
  const card = panel('sprint-panel', 'article');
  card.dataset.sprintId = s.id;
  const info = el('div', undefined, 'sprint-info');
  const titleRow = el('div', undefined, 'sprint-title-row');
  const titleCopy = el('div', undefined, 'sprint-title-copy');
  titleCopy.append(el('p', `${s.state.toUpperCase()} SPRINT`, 'eyebrow'), el('h2', s.name));
  titleRow.append(titleCopy);
  info.append(titleRow, sprintGoal(s.goal), el('small', `${s.start} → ${s.end}`, 'muted'));
  const metrics = metricList([
    [items.length, 'In scope'],
    [items.filter(done).length, s.state === 'closed' ? 'Done now' : 'Done'],
    [items.filter(blocked).length, 'Blocked'],
  ]);
  const actions = el('div', undefined, 'actions sprint-actions');
  const expanded = state.burndownExpanded.has(s.id);
  const toggle = actionIconButton(
    expanded ? 'Hide burn down' : 'Show burn down',
    '▥',
    () => {
      if (expanded) state.burndownExpanded.delete(s.id);
      else state.burndownExpanded.add(s.id);
      render();
      [...document.querySelectorAll('[data-burndown-toggle]')]
        .find((element) => element.dataset.burndownToggle === s.id)
        ?.focus();
    },
    'quiet',
  );
  toggle.dataset.burndownToggle = s.id;
  toggle.setAttribute('aria-expanded', String(expanded));
  if (expanded) toggle.setAttribute('aria-controls', `burndown-${s.id}`);
  toggle.disabled = state.busy || state.loading;
  actions.append(toggle);
  actions.append(
    actionIconButton('View scope', '◎', () => {
      state.view = 'board';
      $('scope').value = s.id;
      render();
      persistPlanningURL();
    }),
  );
  if (s.state !== 'closed')
    actions.append(writeIconButton('Edit sprint', '✎', () => editSprint(s)));
  if (s.state === 'planned')
    actions.append(
      writeIconButton(
        'Start sprint',
        '▶',
        () => quick({ kind: 'sprint.start', target: s.id }),
        'primary',
      ),
    );
  if (s.state === 'active')
    actions.append(writeIconButton('Close sprint', '■', () => closeSprint(s)));
  if (s.state === 'closed')
    actions.append(
      writeIconButton('Re-open sprint', '↶', () => quick({ kind: 'sprint.reopen', target: s.id })),
    );
  if (s.state === 'closed')
    actions.append(writeIconButton('Archive sprint', '▣', () => archiveSprint(s), 'quiet'));
  if (s.state === 'closed')
    info.append(
      el(
        'small',
        'Scope is preserved at closure. Archive this immutable sprint to keep it in paginated history; card details remain current.',
        'muted',
      ),
    );
  card.append(info, actions, metrics);
  if (expanded) card.append(renderBurndown(s));
  card.dataset.renderSignature = JSON.stringify({
    s,
    expanded,
    data: expanded ? state.burndownData.get(currentBurndownKey(s.id)) || null : null,
    error: expanded ? state.burndownErrors.get(currentBurndownKey(s.id)) || null : null,
  });
  return card;
}
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
function renderSprintRows(list) {
  const search = $('search').value.trim();
  const query = state.searchQuery;
  const filtered = state.board.sprints.filter(sprintMatchesFilters);
  const matches = filtered.filter(
    (sprint) => !query || `${sprint.name || ''} ${sprint.goal || ''}`.toLowerCase().includes(query),
  );
  $('count').textContent = `${matches.length} ${matches.length === 1 ? 'sprint' : 'sprints'}`;
  list.replaceChildren();
  if (!matches.length) {
    const message = !state.board.sprints.length
      ? 'No sprints yet. Create a goal and time box, then add work from the backlog.'
      : query && filtered.length !== state.board.sprints.length
        ? `No sprints match “${search}” and the current filters.`
        : query
          ? `No sprints match “${search}”.`
          : 'No sprints hold work matching the current filters.';
    list.append(emptyState(message));
    return;
  }
  matches.forEach((sprint) => list.append(sprintPanel(sprint, sprintFilterItems(sprint))));
}
function sprintHistoryTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unknown closure time'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function renderSprintHistory() {
  const historyPanel = panel('sprint-history');
  historyPanel.append(
    panelHead('Archived sprint history', {
      description:
        'Immutable snapshots captured when each sprint closed. Archived sprints are read-only and do not consume the planning limit.',
    }),
  );
  if (state.sprintHistoryError) historyPanel.append(emptyState(state.sprintHistoryError));
  else if (!state.sprintHistory.length)
    historyPanel.append(
      emptyState(
        'No archived sprints yet. Close and archive a sprint to preserve its closure summary.',
      ),
    );
  else {
    const list = maintenanceList('sprint-history-list');
    state.sprintHistory.forEach((record) => {
      const sprint = record.sprint || {};
      const closure = record.closure || {};
      const row = maintenanceRow({
        content: [
          el('strong', sprint.name || 'Unnamed sprint'),
          el(
            'span',
            `${closure.scope_count || 0} committed · ${closure.completed_count || 0} completed · ${closure.carry_over_count || 0} carried over`,
            'help',
          ),
          el('small', `Closed ${sprintHistoryTime(closure.closed_at)}`, 'muted'),
        ],
      });
      row.dataset.sprintHistoryId = sprint.id || '';
      list.append(row);
    });
    historyPanel.append(list);
  }
  if (!state.sprintHistoryError && state.sprintHistoryMore) {
    const more = button('Load older archived sprints', async () => {
      try {
        await loadSprintHistory();
        render();
      } catch (error) {
        state.sprintHistoryError = error.message;
        render();
      }
    });
    more.dataset.sprintHistoryMore = 'true';
    more.disabled = state.busy || state.loading;
    historyPanel.append(more);
  }
  historyPanel.dataset.renderSignature = JSON.stringify({
    records: state.sprintHistory,
    more: state.sprintHistoryMore,
    error: state.sprintHistoryError,
  });
  return historyPanel;
}
// Delivery trend is derived from preserved closed-sprint scope and the current
// state of those cards. It is a live read of native planning records, not a
// recorded historical metric, so it is labeled as such.
const VELOCITY_SPRINTS = 8;
function velocitySeries() {
  return state.board.sprints
    .filter((sprint) => sprint.state === 'closed' && sprintMatchesFilters(sprint))
    .map((sprint) => {
      const items = sprintFilterItems(sprint);
      return { sprint, committed: items.length, completed: items.filter(done).length };
    })
    .slice(-VELOCITY_SPRINTS);
}
function velocityChart(series) {
  const width = 760,
    height = 200,
    left = 44,
    right = 16,
    top = 16,
    bottom = 40;
  const plotWidth = width - left - right,
    plotHeight = height - top - bottom;
  const maximum = Math.max(1, ...series.flatMap((entry) => [entry.committed, entry.completed]));
  const band = plotWidth / series.length,
    barWidth = Math.max(4, Math.min(28, band / 3));
  const y = (value) => top + ((maximum - value) / maximum) * plotHeight;
  const svg = svgNode('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': 'Committed and completed work per closed sprint',
    class: 'velocity-svg',
  });
  const title = svgNode('title');
  title.textContent = 'Committed and completed work per closed sprint';
  svg.append(title);
  [
    ...new Set(Array.from({ length: 4 }, (_, index) => Math.round(maximum * (1 - index / 3)))),
  ].forEach((value) => {
    svg.append(
      svgNode('line', {
        class: 'velocity-grid',
        x1: left,
        x2: width - right,
        y1: y(value),
        y2: y(value),
      }),
    );
    const label = svgNode('text', {
      class: 'velocity-axis-label',
      x: left - 8,
      y: y(value) + 4,
      'text-anchor': 'end',
    });
    label.textContent = String(value);
    svg.append(label);
  });
  series.forEach((entry, index) => {
    const center = left + band * (index + 0.5);
    [
      ['committed', entry.committed, center - barWidth - 2],
      ['completed', entry.completed, center + 2],
    ].forEach(([kind, value, x]) => {
      const bar = svgNode('rect', {
        class: `velocity-bar velocity-bar-${kind}`,
        x,
        y: y(value),
        width: barWidth,
        height: Math.max(1, y(0) - y(value)),
      });
      const label = svgNode('title');
      label.textContent = `${entry.sprint.name} · ${value} ${kind}`;
      bar.append(label);
      svg.append(bar);
    });
    const label = svgNode('text', {
      class: 'velocity-axis-label',
      x: center,
      y: height - 14,
      'text-anchor': 'middle',
    });
    label.textContent =
      entry.sprint.name.length > 14 ? `${entry.sprint.name.slice(0, 13)}…` : entry.sprint.name;
    svg.append(label);
  });
  return svg;
}
function velocityTable(series) {
  const details = el('details', undefined, 'velocity-data');
  details.dataset.stateKey = 'velocity-data';
  details.append(el('summary', 'View sprint values'));
  const scroll = el('div', undefined, 'velocity-table-scroll');
  const table = el('table');
  table.append(el('caption', 'Closed-sprint scope and current completion'));
  const head = el('thead');
  const heading = el('tr');
  ['Sprint', 'Committed', 'Completed'].forEach((text) => {
    const cell = el('th', text);
    cell.scope = 'col';
    heading.append(cell);
  });
  head.append(heading);
  table.append(head);
  const body = el('tbody');
  series.forEach((entry) => {
    const row = el('tr');
    const name = el('th', entry.sprint.name);
    name.scope = 'row';
    row.append(name, el('td', String(entry.committed)), el('td', String(entry.completed)));
    body.append(row);
  });
  table.append(body);
  scroll.append(table);
  details.append(scroll);
  return details;
}
function sprintVelocityPanel() {
  const series = velocitySeries();
  const trend = panel('velocity-panel');
  trend.setAttribute('aria-labelledby', 'velocity-heading');
  trend.append(
    panelHead('Delivery trend', {
      id: 'velocity-heading',
      description: `Committed and completed work for the last ${VELOCITY_SPRINTS} closed sprints. Completion reflects each card's current column, not its state at closure.`,
    }),
  );
  if (!series.length) {
    const narrowed = state.board.sprints.some((sprint) => sprint.state === 'closed');
    trend.append(
      emptyState(
        narrowed
          ? 'No closed sprint holds work matching the current filters.'
          : 'No closed sprint yet. Close a sprint to start a delivery trend.',
      ),
    );
    trend.dataset.renderSignature = `velocity:empty:${narrowed}`;
    return trend;
  }
  const completed = series.map((entry) => entry.completed);
  const average = completed.reduce((sum, value) => sum + value, 0) / completed.length;
  const metrics = metricList(
    [
      [series.at(-1).completed, 'Last sprint'],
      [Math.round(average * 10) / 10, 'Average completed'],
      [Math.max(...completed), 'Best sprint'],
    ],
    'velocity-metrics',
  );
  const figure = el('figure', undefined, 'velocity-figure');
  figure.append(velocityChart(series));
  const legend = el('div', undefined, 'velocity-legend');
  [
    ['committed', 'Committed'],
    ['completed', 'Completed'],
  ].forEach(([kind, text]) => {
    const entry = el('span', undefined, 'velocity-legend-item');
    entry.append(
      el('span', undefined, `velocity-swatch velocity-swatch-${kind}`),
      el('span', text),
    );
    legend.append(entry);
  });
  figure.append(legend);
  trend.append(metrics, figure, velocityTable(series));
  trend.dataset.renderSignature = JSON.stringify(
    series.map((entry) => [entry.sprint.id, entry.sprint.name, entry.committed, entry.completed]),
  );
  return trend;
}
// Sprints uses the same page layout as Projects: a read-only summary section
// first, then a titled section whose filter bar sits directly below its heading.
function renderSprintPage(content) {
  const velocity = sprintVelocityPanel();
  const head = sectionHead(
    'Goals, scope, and deliberate carry-over',
    writeButton('＋ New sprint', () => editSprint(), 'primary'),
  );
  head.dataset.renderSignature = 'sprint-page-head';
  const list = el('div', undefined, 'sprints');
  list.dataset.contentView = 'sprint-page-list';
  renderSprintRows(list);
  const historyPanel = renderSprintHistory();
  const current = pageRoot('sprint-page');
  if (!current) {
    const sections = pageStack('sprint-page');
    const planning = el('section', undefined, 'sprint-planning');
    planning.append(head, filterSlot('sprint-filter-slot'), list);
    sections.append(velocity, planning, historyPanel);
    content.append(sections);
  } else {
    patchNode(current.firstElementChild, velocity);
    const planning = current.children[1];
    patchNode(planning.firstElementChild, head);
    reconcileKeyedChildren(planning.lastElementChild, [...list.children], keyedNodeKey);
    patchNode(current.children[2], historyPanel);
  }
  placeFilters($('sprint-filter-slot'));
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
function renderSprintSummary(sprints) {
  const summary = $('sprint-summary');
  if (state.view !== 'board') {
    summary.replaceChildren();
    return;
  }
  const next = sprints.map((sprint) => sprintPanel(sprint));
  if (!next.length)
    next.push(
      emptyState(
        'No active sprint. Use Sprint planning to create and start one, or keep a continuous Kanban flow.',
      ),
    );
  reconcileKeyedChildren(summary, next, keyedNodeKey);
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
async function loadHistory(reset = false) {
  const events = await api(
    state.root +
      '/history' +
      (!reset && state.historyBefore ? `?before=${state.historyBefore}` : ''),
  );
  state.history = reset ? events : [...state.history, ...events];
  state.historyBefore = events.at(-1)?.id || 0;
  state.historyMore = events.length === 50;
}
const SPRINT_HISTORY_PAGE = 50;
function resetSprintHistory() {
  state.sprintHistory = [];
  state.sprintHistoryOffset = 0;
  state.sprintHistoryMore = false;
  state.sprintHistoryError = '';
}
function validSprintHistoryPage(page) {
  return (
    page &&
    Array.isArray(page.records) &&
    Number.isSafeInteger(page.total) &&
    page.total >= 0 &&
    page.records.every(
      (record) =>
        record &&
        record.sprint &&
        typeof record.sprint.id === 'string' &&
        record.closure &&
        typeof record.closure.closed_at === 'string' &&
        !Number.isNaN(Date.parse(record.closure.closed_at)),
    ) &&
    (page.next_offset === undefined ||
      (Number.isSafeInteger(page.next_offset) && page.next_offset >= 0))
  );
}
async function loadSprintHistory(reset = false) {
  const offset = reset ? 0 : state.sprintHistoryOffset;
  const page = await api(
    `${state.root}/sprints/archive?offset=${offset}&limit=${SPRINT_HISTORY_PAGE}`,
  );
  if (!validSprintHistoryPage(page))
    throw new Error('Sprint history response is invalid. Refresh to retry.');
  state.sprintHistory = reset ? page.records : [...state.sprintHistory, ...page.records];
  state.sprintHistoryOffset = offset + page.records.length;
  state.sprintHistoryMore = page.next_offset !== undefined;
  state.sprintHistoryError = '';
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
function historyActorLabel(subject) {
  const member = state.board.members.find((candidate) => candidate.subject === subject);
  const name = member
    ? memberListingInfo(member).name
    : subject === state.session?.subject
      ? String(state.session.name || '').trim()
      : '';
  return name ? `${name} (${subject})` : subject;
}
function renderHistory(content) {
  const page = pageStack('history');
  const label = workspaceHistoryLabel(state.board.workspace);
  page.append(el('p', label, 'muted'));
  if (!state.history.length) page.append(emptyState('No planning changes yet.'));
  const list = el('div', undefined, 'history-list');
  state.history.forEach((e) => {
    const row = el('article', undefined, 'history-row');
    row.append(
      el('strong', e.action.replaceAll('.', ' · ')),
      el(
        'p',
        `${historyActorLabel(e.actor)} · ${new Date(e.at).toLocaleString()} · ${label} · ${e.legacy_project_id ? 'legacy project' : 'workspace'} revision ${e.revision}`,
        'muted',
      ),
    );
    if (e.target) row.append(el('small', `Target ${e.target}`, 'card-id'));
    if (e.reason) row.append(el('p', e.reason));
    list.append(row);
  });
  if (list.childElementCount) page.append(list);
  if (state.historyMore)
    page.append(
      button('Load older changes', async () => {
        try {
          await loadHistory();
          renderContent();
        } catch (e) {
          notice(e.message, true);
        }
      }),
    );
  content.append(page);
}
async function showProposals(before = 0) {
  if (!state.board || state.busy || state.loading) return;
  const currentRoot = state.root;
  try {
    const rows = await api(currentRoot + '/proposals?before=' + before);
    if (state.root !== currentRoot || state.busy) return;
    $('editor').close();
    openEditor(
      'Planning proposals',
      (fields) => {
        fields.append(
          helpText(
            'Agent output is an unverified suggestion. Importing creates a draft only; a human must review the exact diff before any planning changes.',
          ),
        );
        fields.append(writeButton('Import proposal or migration JSON', () => importProposal()));
        if (!rows.length) fields.append(emptyState('No proposals on this page.'));
        for (const row of rows) {
          const card = el('article', undefined, 'setup-row');
          card.append(
            el('strong', row.title),
            el(
              'p',
              `${row.state} · Imported by ${row.imported_by} · workspace revision ${row.revision}`,
              'muted',
            ),
            button('Review ' + row.title, () => reviewProposal(row.id)),
          );
          fields.append(card);
        }
        if (rows.length === 20)
          fields.append(button('Older proposals', () => showProposals(rows.at(-1).sequence)));
        if (before) fields.append(button('Newest proposals', () => showProposals()));
      },
      () => ({}),
      true,
    );
  } catch (e) {
    notice(e.message, true);
  }
}
function importProposal(document) {
  $('editor').close();
  const id = requestKey();
  openEditor(
    'Import proposal draft',
    (fields) => {
      fields.append(
        helpText(
          'Paste a version-1 proposal or the document/report from flux import. This saves a draft, not planning changes. Source identity and agent provenance are not verified.',
        ),
      );
      const input = field(
        fields,
        'document',
        'Proposal JSON',
        document ? JSON.stringify(document, null, 2) : '',
        'textarea',
      );
      input.required = true;
      input.maxLength = 60000;
      field(fields, 'reason', 'Import rationale', '', 'textarea').required = true;
    },
    (data) => {
      const parsed = JSON.parse(data.get('document'));
      if (parsed.unresolved?.length)
        throw new Error('Resolve all import mappings before creating a draft.');
      return {
        kind: 'proposal.import',
        target: id,
        proposal: parsed.document || parsed,
        reason: data.get('reason').trim(),
      };
    },
  );
  $('save').textContent = 'Save draft only';
}
async function reviewProposal(id) {
  const currentRoot = state.root;
  try {
    const preview = await api(currentRoot + '/proposals/' + encodeURIComponent(id));
    if (state.root !== currentRoot || state.busy) return;
    const v = preview.proposal;
    const canAccept = v.state === 'draft' && !!preview.digest && !preview.problem && writable();
    $('editor').close();
    openEditor(
      'Review planning proposal',
      (fields) => {
        fields.append(
          el('h3', v.document.title, 'proposal-text'),
          el('p', v.document.rationale, 'proposal-text'),
          helpText(`Claimed provenance (unverified): ${v.document.provenance}`, 'proposal-text'),
          el(
            'p',
            `Imported by ${v.imported_by} · ${v.state}${v.reviewed_by ? ' · Reviewed by ' + v.reviewed_by : ''}`,
          ),
        );
        if (v.review_reason) fields.append(el('p', v.review_reason, 'proposal-text'));
        if (preview.problem) fields.append(errorLine(preview.problem));
        fields.append(
          helpText(
            `New imports: ${preview.created || 0} · Already imported, retained unchanged: ${Object.keys(preview.skipped || {}).length}`,
          ),
        );
        if (Object.keys(preview.workspace_changes || {}).length)
          fields.append(
            el('h3', 'Workspace changes'),
            el('pre', JSON.stringify(preview.workspace_changes, null, 2), 'proposal-data'),
          );
        for (const change of preview.changes || []) {
          const row = el('section', undefined, 'setup-row');
          row.append(el('strong', 'Native item ' + change.id));
          for (const [name, values] of Object.entries(change.fields)) {
            row.append(
              el('h4', name),
              el(
                'pre',
                'Before: ' +
                  JSON.stringify(values.before, null, 2) +
                  '\nAfter: ' +
                  JSON.stringify(values.after, null, 2),
                'proposal-data',
              ),
            );
          }
          fields.append(row);
        }
        const details = el('details');
        details.append(
          el('summary', 'Original document, evidence and skipped sources'),
          el(
            'pre',
            JSON.stringify({ document: v.document, skipped: preview.skipped }, null, 2),
            'proposal-data',
          ),
        );
        fields.append(details);
        if (v.state === 'draft') {
          fields.append(
            writeButton('Revise as new draft', () => importProposal(v.document)),
            writeButton('Reject proposal', () => rejectProposal(v.id)),
          );
        }
        if (canAccept) {
          field(fields, 'reason', 'Approval rationale', '', 'textarea').required = true;
          const consent = field(
            fields,
            'consent',
            'I reviewed and approve this exact diff',
            'yes',
            'checkbox',
          );
          consent.required = true;
          consent.parentElement.classList.add('consent');
          consent.parentElement.prepend(consent);
        }
      },
      (data) => {
        if (!data.get('consent')) throw new Error('Explicit approval is required.');
        return {
          kind: 'proposal.accept',
          target: v.id,
          revision: v.document.revision,
          name: preview.digest,
          reason: data.get('reason').trim(),
        };
      },
      !canAccept,
    );
    $('save').textContent = 'Accept exact diff';
  } catch (e) {
    notice(e.message, true);
  }
}
async function rejectProposal(id) {
  if (!(await refresh())) return;
  $('editor').close();
  openEditor(
    'Reject planning proposal',
    (fields) => {
      field(fields, 'reason', 'Rejection rationale', '', 'textarea').required = true;
    },
    (data) => ({ kind: 'proposal.reject', target: id, reason: data.get('reason').trim() }),
  );
  $('save').textContent = 'Reject proposal';
}
function editSprint(sprint) {
  const existing = !!sprint;
  sprint ||= {
    name: '',
    goal: '',
    start: new Date().toISOString().slice(0, 10),
    end: new Date(Date.now() + 13 * 86400000).toISOString().slice(0, 10),
  };
  openEditor(
    existing ? 'Edit sprint' : 'Plan a sprint',
    (fields) => {
      const name = field(fields, 'name', 'Sprint name', sprint.name);
      name.required = true;
      name.maxLength = 120;
      markdownEditor(
        fields,
        'goal',
        'Sprint goal · what outcome matters?',
        sprint.goal,
        4000,
        false,
        false,
        'sprint goal',
      );
      const grid = el('div', undefined, 'form-grid');
      fields.append(grid);
      field(grid, 'start', 'Start date', sprint.start, 'date').required = true;
      field(grid, 'end', 'End date', sprint.end, 'date').required = true;
      fields.append(
        helpText(
          'Add or remove scope by editing an item’s sprint membership. Sprints belong to the workspace and can span projects. Multiple sprints can be active.',
        ),
      );
    },
    (data) => {
      const goal = String(data.get('goal') || '').trim();
      if (!goal) throw new Error('Sprint goal is required.');
      return {
        kind: 'sprint.save',
        target: sprint.id || '',
        sprint: {
          ...sprint,
          name: data.get('name').trim(),
          goal,
          start: data.get('start'),
          end: data.get('end'),
        },
      };
    },
  );
}
function closeSprint(sprint) {
  const items = scopeItems(sprint);
  const unfinished = items.filter((i) => !done(i));
  openEditor(
    'Close sprint & decide carry-over',
    (fields) => {
      fields.append(
        el(
          'p',
          `${sprint.name}: ${items.length} items in scope; ${unfinished.length} unfinished. Closing freezes this sprint’s scope. Other sprint assignments remain unchanged; the card keeps its identity and column.`,
        ),
      );
      field(fields, 'destination', 'Also assign unfinished work to', '', 'text', [
        ['', 'No additional sprint'],
        ...state.board.sprints
          .filter((s) => (s.state === 'planned' || s.state === 'active') && s.id !== sprint.id)
          .map((s) => [s.id, s.name]),
      ]);
      fields.append(
        helpText(
          'No additional sprint returns an item to backlog only if it has no other open sprint membership. Existing memberships are never removed by closing another sprint.',
        ),
      );
      const reason = field(fields, 'reason', 'Closing decision / rationale', '', 'textarea');
      reason.required = true;
      reason.maxLength = 4000;
    },
    (data) => ({
      kind: 'sprint.close',
      target: sprint.id,
      destination: data.get('destination'),
      reason: data.get('reason').trim(),
    }),
  );
  $('save').textContent = 'Close sprint';
}
function archiveSprint(sprint) {
  openEditor(
    'Archive sprint',
    (fields) => {
      fields.append(
        el(
          'p',
          `Archive “${sprint.name}”? The sprint will become immutable and leave the working sprint list. Its closure summary and metadata remain available in history.`,
        ),
      );
      fields.append(
        helpText(
          'Archiving does not delete cards or change their current columns. A closed sprint cannot be reopened after it is archived.',
        ),
      );
    },
    () => ({ kind: 'sprint.archive', target: sprint.id }),
  );
  $('save').textContent = 'Archive sprint';
}
function editProject(project) {
  $('editor').close();
  openEditor(
    project ? 'Edit project' : 'Create project',
    (fields) => {
      const name = field(fields, 'name', 'Project name', project?.name || '');
      name.required = true;
      name.maxLength = 120;
      fields.append(
        helpText(
          'Projects classify work in this workspace. Boards, sprint scope, WIP and permissions stay workspace-wide.',
        ),
      );
    },
    (data) => ({
      kind: 'project.save',
      target: project?.id || '',
      project: { ...(project || {}), name: data.get('name').trim() },
    }),
  );
}
function integrationProjectChips(projectIDs) {
  const catalog = new Map(state.integrationCatalog.map((project) => [String(project.id), project]));
  const chips = el('div', undefined, 'tags integration-project-chips');
  chips.setAttribute('aria-label', 'Approved GitLab projects');
  projectIDs.forEach((id) => {
    const project = catalog.get(String(id));
    const label = project ? gitlabProjectLabel(project) : `GitLab project #${id}`;
    const chip = el('span', label, 'badge integration-project-chip');
    chip.title = label;
    chips.append(chip);
  });
  return chips;
}
function openProject(project) {
  if (!state.board || !project || state.busy || state.loading || state.integrationFormOpen) return;
  if (state.detailState && !closeDetail({ focus: false })) return;
  state.view = 'board';
  state.presentation = 'list';
  setFilterValues('project', [project.id]);
  setFilterValues('assignee', []);
  setFilterValues('label', []);
  $('scope').value = 'all';
  resetSearch();
  render();
  persistPlanningURL();
}
function renderProjectFilterChips(host, list, count) {
  const chips = filterChipNodes(
    projectFilters,
    PROJECT_FILTER_NAMES,
    () => renderProjectRows(list, count, host),
    { clearLabel: 'Clear project filters' },
  );
  host.hidden = !chips.length;
  host.replaceChildren(...chips);
}
function projectMatchesFilters(project) {
  if (!projectFilters.assignee.size && !projectFilters.label.size) return true;
  return state.board.items.some((item) =>
    item.archived
      ? false
      : itemProjectIDs(item).includes(project.id) &&
        matchesFilter('assignee', item.assignee ? [item.assignee] : [], projectFilters) &&
        matchesFilter('label', item.labels || [], projectFilters),
  );
}
function renderProjectRows(list, count, chips) {
  const search = state.projectSearch.trim();
  const query = search.toLowerCase();
  const filtered = state.board.projects.filter(projectMatchesFilters);
  const matches = filtered.filter((project) => project.name.toLowerCase().includes(query));
  if (count) count.textContent = `${matches.length} project${matches.length === 1 ? '' : 's'}`;
  if (chips) renderProjectFilterChips(chips, list, count);
  list.replaceChildren();
  if (!matches.length) {
    const narrowed = filtered.length !== state.board.projects.length;
    const message = !state.board.projects.length
      ? 'No projects yet. Items can remain unclassified.'
      : query && narrowed
        ? `No projects match \u201c${search}\u201d and the current filters.`
        : query
          ? `No projects match \u201c${search}\u201d.`
          : 'No projects hold work matching the current filters.';
    list.append(emptyState(message));
    return;
  }
  matches.forEach((project) => {
    const open = actionIconButton('View scope', '◎', () => openProject(project));
    open.disabled = state.busy || state.loading || state.integrationFormOpen;
    list.append(
      maintenanceRow({
        content: [el('strong', project.name)],
        actions: [open, writeIconButton('Edit project', '✎', () => editProject(project))],
      }),
    );
  });
}
function renderProjects(content) {
  const approvedIDs = state.board.integration?.projects || [];
  if (
    !state.integrationFormOpen &&
    state.board.connector_instance &&
    approvedIDs.length &&
    !state.integrationCatalogLoaded &&
    !state.integrationCatalogLoading
  )
    void loadIntegrationCatalog();
  const sections = pageStack('projects');
  const integration = panel('maintenance-section');
  const integrationHead = sectionHead('GitLab integration');
  if (state.integrationFormOpen) {
    integration.append(integrationHead, renderIntegrationForm());
  } else {
    const edit = writeButton('Edit integration', editIntegration);
    edit.dataset.write = 'true';
    integrationHead.append(edit);
    const configured = state.board.connector_instance || 'Not configured';
    const approved = approvedIDs.length;
    integration.append(
      integrationHead,
      helpText(`Operator-configured GitLab instance: ${configured}`),
      helpText(`${approved} approved GitLab project${approved === 1 ? '' : 's'}.`),
    );
    if (approved) integration.append(integrationProjectChips(approvedIDs));
    if (state.integrationCatalogLoading)
      integration.append(helpText('Loading approved GitLab project names…'));
    if (state.integrationCatalogError)
      integration.append(
        helpText(
          `Project names are unavailable; approved IDs remain visible. ${state.integrationCatalogError}`,
        ),
      );
    if (!state.board.connector_instance)
      integration.append(
        helpText(
          'Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN to enable the connector.',
        ),
      );
  }
  const projects = el('section', undefined, 'workspace-projects');
  const newProject = writeButton('＋ New project', () => editProject(), 'primary');
  newProject.dataset.write = 'true';
  // Each select adds one value and resets, exactly like the planning bar.
  const { bar, controls, count: projectCount } = filterBar();
  const assigneeFilter = filterSelect('Assignee', [
    ['all', 'Any assignee'],
    ['none', 'Unassigned'],
    ...state.board.members.map((member) => [member.subject, memberName(member.subject)]),
  ]);
  const labelFilter = filterSelect('Label', [
    ['all', 'Any label'],
    ['none', 'No labels'],
    ...state.board.labels.map((label) => [label.name, label.name]),
  ]);
  const search = filterSearch('Search', {
    value: state.projectSearch,
    placeholder: 'Find projects…',
    maxLength: 120,
  });
  controls.append(assigneeFilter.label, labelFilter.label, search.label);
  const projectChips = filterChipRow('Active project filters');
  projects.append(
    sectionHead('Workspace projects', newProject),
    filterSlot('', bar, projectChips),
    helpText(
      'Projects classify work in this workspace. Boards, sprint scope, WIP and permissions stay workspace-wide. Assignee and Label filters list projects with current non-archived work matching every active filter; Unassigned and No labels match empty values.',
    ),
  );
  const list = maintenanceList();
  renderProjectRows(list, projectCount, projectChips);
  search.input.addEventListener('input', () => {
    state.projectSearch = search.input.value;
    renderProjectRows(list, projectCount, projectChips);
  });
  PROJECT_FILTER_NAMES.forEach((name, index) => {
    const select = index === 0 ? assigneeFilter.select : labelFilter.select;
    select.addEventListener('change', () => {
      addFilterValue(name, select.value, projectFilters);
      select.value = 'all';
      renderProjectRows(list, projectCount, projectChips);
    });
  });
  projects.append(list);

  sections.append(integration, projects);
  content.append(sections);
}
function editLabel(label) {
  $('editor').close();
  const originalName = typeof label === 'string' ? label : label?.name || '';
  const originalColor =
    typeof label === 'string' ? labelInfo(label).color : label?.color || '#dcefe4';
  openEditor(
    originalName ? 'Rename label' : 'Create label',
    (fields) => {
      const input = field(fields, 'name', 'Label name', originalName);
      input.required = true;
      input.maxLength = 60;
      labelColorPicker(fields, originalColor);
      fields.append(
        helpText(
          'Use optional scope::value names such as type::bug or priority::high. Choose from the fixed 64-swatch palette. Renaming updates every assigned card, including archived work.',
        ),
      );
    },
    (data) => ({
      kind: 'label.save',
      target: originalName,
      name: data.get('name').trim(),
      color: data.get('color') || originalColor,
    }),
  );
}
function deleteLabel(label) {
  $('editor').close();
  openEditor(
    'Delete label',
    (fields) => {
      fields.append(
        el(
          'p',
          `Remove “${label.name}” from the workspace and all ${state.board.items.filter((i) => i.labels.includes(label.name)).length} assigned cards, including archived work? Historical audit is retained.`,
        ),
      );
    },
    () => ({ kind: 'label.delete', target: label.name }),
  );
  $('save').textContent = 'Delete label';
}
function renderLabels(content) {
  $('count').textContent = state.board.labels.length
    ? `${state.board.labels.length} label${state.board.labels.length === 1 ? '' : 's'}`
    : '';
  const page = pageStack('labels');
  const newLabel = writeButton('＋ New label', () => editLabel(), 'primary');
  newLabel.dataset.write = 'true';
  page.append(
    sectionHead('Workspace labels', newLabel),
    helpText(
      'Create, rename and remove the reusable labels used to classify work in this workspace.',
    ),
  );
  content.append(page);
  if (!state.board.labels.length) {
    page.append(emptyState('No labels yet. Create reusable labels for this workspace.'));
    return;
  }
  const list = maintenanceList('label-maintenance-list');
  state.board.labels.forEach((label) => {
    const usage = state.board.items.filter((item) => item.labels.includes(label.name)).length;
    list.append(
      maintenanceRow({
        tag: 'article',
        className: 'label-maintenance-row',
        content: [
          labelBadge(label.name),
          el('small', `${usage} card${usage === 1 ? '' : 's'}`, 'muted'),
        ],
        actions: [
          writeIconButton('Rename', '✎', () => editLabel(label)),
          writeIconButton('Delete…', '×', () => deleteLabel(label), 'danger'),
        ],
      }),
    );
  });
  page.append(list);
}
const MEMBER_ROLE_ENTRIES = [
  ['viewer', 'Viewer'],
  ['member', 'Member'],
  ['admin', 'Admin'],
];
function memberRoleLabel(role) {
  return MEMBER_ROLE_ENTRIES.find(([value]) => value === role)?.[1] || role;
}
function memberRoleChip(role) {
  const roleClass = MEMBER_ROLE_ENTRIES.some(([value]) => value === role) ? role : 'unknown';
  const chip = el('span', memberRoleLabel(role), `badge member-role member-role-${roleClass}`);
  chip.setAttribute('aria-label', `Role: ${memberRoleLabel(role)}`);
  return chip;
}
function memberIdentityView(member) {
  const info = memberListingInfo(member);
  const identity = el('div', undefined, 'member-identity');
  identity.append(avatarView(info.name, info.avatarURL));
  const copy = el('div', undefined, 'member-identity-copy');
  copy.append(el('strong', info.name));
  const username = String(member.username || '').trim();
  const meta = el('div', undefined, 'member-identity-meta');
  if (username) meta.append(el('small', `@${username}`, 'muted'));
  meta.append(memberRoleChip(member.role));
  copy.append(meta);
  identity.append(copy);
  return identity;
}
function editMember(member) {
  if (!adminWritable()) return;
  $('editor').close();
  openEditor(
    'Edit workspace member',
    (fields) => {
      const subject = field(fields, 'subject', 'GitLab subject', member.subject);
      subject.readOnly = true;
      subject.setAttribute('aria-readonly', 'true');
      const name = field(fields, 'name', 'Workspace name', member.name || '');
      name.maxLength = 120;
      name.placeholder = 'Optional admin-maintained name';
      field(fields, 'role', 'Workspace role', member.role, 'text', MEMBER_ROLE_ENTRIES);
      fields.append(
        helpText('Leave the workspace name blank to use the available GitLab profile name.'),
      );
    },
    (data) => ({
      kind: 'member.save',
      target: member.subject,
      member: { subject: member.subject, name: data.get('name').trim(), role: data.get('role') },
    }),
  );
  $('save').textContent = 'Save member';
}
function removeMember(member) {
  if (!adminWritable()) return;
  const assigned = state.board.items.filter((item) => item.assignee === member.subject).length;
  $('editor').close();
  openEditor(
    'Remove workspace member',
    (fields) => {
      fields.append(
        memberIdentityView(member),
        el(
          'p',
          `Remove ${memberListingInfo(member).name} from this workspace? Workspace history is retained.`,
        ),
      );
      if (assigned)
        fields.append(
          helpText(
            `This member is assigned to ${assigned} card${assigned === 1 ? '' : 's'}. Reassign those cards before removing the member.`,
          ),
        );
    },
    () => ({ kind: 'member.delete', target: member.subject }),
  );
  $('save').textContent = 'Remove member';
}
function addMember() {
  if (!adminWritable()) return;
  const currentBoard = state.board,
    currentRoot = state.root;
  $('editor').close();
  openEditor(
    'Add workspace member',
    (fields) => {
      fields.append(
        helpText(
          'Search active users from the configured GitLab instance. Adding a user grants access to this workspace only; it does not change GitLab permissions.',
        ),
      );
      let searchTimer,
        searchGeneration = 0,
        nameEdited = false;
      const usersBySubject = new Map();
      let subjectInput, nameInput;
      const syncSelectedUser = (values) => {
        const subject = String(values[0] || '');
        subjectInput.value = subject;
        if (!nameEdited) nameInput.value = usersBySubject.get(subject)?.name || '';
      };
      const queueUsers = (query, controls) => {
        if (searchTimer) clearTimeout(searchTimer);
        const generation = ++searchGeneration;
        const search = query.trim();
        controls.setStatus(search ? 'Searching GitLab…' : 'Loading GitLab users…');
        searchTimer = setTimeout(
          async () => {
            try {
              const users = await loadGitLabUsers(currentRoot, search);
              if (
                generation !== searchGeneration ||
                state.board !== currentBoard ||
                state.root !== currentRoot
              )
                return;
              users.forEach((user) => usersBySubject.set(String(user.id), user));
              const selected = controls.selected();
              const entries = memberUserEntries(users, selected);
              controls.setEntries(entries, selected);
              controls.setStatus(
                entries.length ? '' : 'No available GitLab users match this search.',
              );
            } catch (error) {
              if (
                generation === searchGeneration &&
                state.board === currentBoard &&
                state.root === currentRoot
              )
                controls.setStatus(error.message || String(error));
            }
          },
          search ? 250 : 0,
        );
      };
      multiSelect(
        fields,
        'gitlab_user',
        'GitLab user',
        [],
        [],
        undefined,
        'Only users returned by the configured server-side GitLab connector can be added. Existing workspace members are omitted.',
        { single: true, onOpen: queueUsers, onFilter: queueUsers, onChange: syncSelectedUser },
      );
      subjectInput = field(fields, 'subject', 'GitLab subject', '');
      subjectInput.readOnly = true;
      subjectInput.required = true;
      subjectInput.placeholder = 'Select a GitLab user';
      subjectInput.setAttribute('aria-readonly', 'true');
      nameInput = field(fields, 'name', 'Workspace name', '');
      nameInput.maxLength = 120;
      nameInput.placeholder = 'Defaults to the GitLab profile name';
      nameInput.addEventListener('input', () => {
        nameEdited = true;
      });
      field(fields, 'role', 'Workspace role', 'member', 'text', MEMBER_ROLE_ENTRIES);
      if (!currentBoard.connector_instance)
        fields.append(
          helpText(
            'A GitLab read connector is not configured. Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN.',
          ),
        );
    },
    (data) => {
      const subject = String(data.get('gitlab_user') || '').trim();
      if (!/^[1-9][0-9]*$/.test(subject) || !Number.isSafeInteger(Number(subject)))
        throw new Error('Select an available GitLab user.');
      return {
        kind: 'member.save',
        member: { subject, role: data.get('role'), name: String(data.get('name') || '').trim() },
      };
    },
  );
  $('save').textContent = 'Add member';
}
function renderMembers(content) {
  $('count').textContent =
    `${state.board.members.length} member${state.board.members.length === 1 ? '' : 's'}`;
  const page = pageStack('members');
  const admin = state.board.role === 'admin';
  page.append(
    sectionHead(
      'Workspace members',
      admin ? adminButton('＋ Add member', addMember, 'primary') : undefined,
    ),
    helpText(
      admin
        ? 'Manage workspace access and roles. OAuth supplies the signed-in user’s GitLab profile; other numeric members need the server-side read connector for names, usernames, and avatars. Bootstrap, non-GitLab, or unavailable profiles may not have a username or avatar.'
        : 'Review workspace members and roles. Only workspace admins can add members, remove members, change roles, or maintain display names.',
    ),
  );
  content.append(page);
  if (!state.board.members.length) {
    page.append(emptyState('No workspace members yet.'));
    return;
  }
  const list = maintenanceList();
  state.board.members.forEach((member) =>
    list.append(
      maintenanceRow({
        content: [memberIdentityView(member)],
        actions: admin
          ? [
              adminIconButton('Edit member', '✎', () => editMember(member)),
              adminIconButton('Remove member', '−', () => removeMember(member), 'danger'),
            ]
          : [],
      }),
    ),
  );
  page.append(list);
}
function editIntegration() {
  if (!state.board || state.busy || state.loading || state.integrationFormOpen) return;
  state.integrationFormOpen = true;
  state.integrationCatalog = [];
  state.integrationCatalogLoaded = false;
  state.integrationCatalogError = '';
  state.integrationCatalogLoading = false;
  state.integrationCatalogRequest++;
  if (state.board.connector_instance) void loadIntegrationCatalog();
  else render();
}
async function loadIntegrationCatalog() {
  if (!state.board || state.integrationCatalogLoading || state.view !== 'projects') return;
  const currentBoard = state.board,
    currentRoot = state.root,
    request = ++state.integrationCatalogRequest;
  state.integrationCatalogLoading = true;
  state.integrationCatalogError = '';
  if (state.integrationFormOpen) {
    render();
    notice('Loading available GitLab projects…');
  }
  try {
    const catalog = await loadGitLabProjects(currentRoot);
    if (
      request !== state.integrationCatalogRequest ||
      state.board !== currentBoard ||
      state.root !== currentRoot
    )
      return;
    state.integrationCatalog = catalog;
    state.integrationCatalogLoaded = true;
  } catch (error) {
    if (
      request !== state.integrationCatalogRequest ||
      state.board !== currentBoard ||
      state.root !== currentRoot
    )
      return;
    state.integrationCatalogError = error.message;
    state.integrationCatalogLoaded = true;
  } finally {
    // biome-ignore lint/correctness/noUnsafeFinally: a superseded request must not render; try/catch never rethrow.
    if (request !== state.integrationCatalogRequest) return;
    state.integrationCatalogLoading = false;
    if (state.board === currentBoard && state.root === currentRoot && state.view === 'projects') {
      if (state.integrationFormOpen) notice('');
      render();
    }
  }
}
function renderIntegrationForm() {
  const currentBoard = state.board;
  const readOnly = currentBoard.role !== 'admin';
  const selected = currentBoard.integration.projects.map(String);
  const form = el('form', undefined, 'inline-maintenance-form');
  form.append(
    helpText(
      `Operator-configured instance: ${currentBoard.connector_instance || 'Not configured'}`,
    ),
  );
  form.append(helpText(`Existing approval: ${currentBoard.integration.instance || 'None'}`));
  multiSelect(
    form,
    'projects',
    'Approved GitLab projects',
    integrationProjectEntries(state.integrationCatalog, selected),
    selected,
    undefined,
    'Choose projects visible to the configured server-side read connector. The selected projects and their engineering metadata are shared with every workspace reader.',
  );
  if (state.integrationCatalogLoading) form.append(helpText('Loading available GitLab projects…'));
  if (state.integrationCatalogError) {
    form.append(
      errorLine(
        `Could not load the GitLab project list. ${state.integrationCatalogError} Existing approvals remain available so they are not removed accidentally.`,
      ),
    );
    const retry = button('Retry loading projects', loadIntegrationCatalog);
    retry.disabled = readOnly || state.integrationCatalogLoading;
    form.append(retry);
  } else if (
    currentBoard.connector_instance &&
    !state.integrationCatalogLoading &&
    !state.integrationCatalog.length
  ) {
    form.append(helpText('No GitLab projects are visible to the configured read connector.'));
  }
  form.append(
    helpText(
      'Every workspace member, including viewers and authorized machine readers, can see engineering metadata from these projects. Revoking a project or changing the instance removes its links and cached observations; cards and audit remain. No selected projects disables the integration.',
    ),
  );
  const consent = field(
    form,
    'consent',
    'I approve this metadata visibility and any removals',
    'yes',
    'checkbox',
  );
  consent.required = true;
  consent.parentElement.classList.add('consent');
  if (!currentBoard.connector_instance)
    form.append(
      helpText(
        'Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN. Planning works without a connector.',
      ),
    );
  const error = errorLine();
  form.append(error);
  const actions = el('div', undefined, 'dialog-foot inline-maintenance-actions');
  const cancel = button('Cancel', () => {
    state.integrationFormOpen = false;
    state.integrationCatalogError = '';
    state.integrationCatalogLoading = false;
    state.integrationCatalogRequest++;
    render();
  });
  actions.append(cancel);
  let save;
  if (!readOnly) {
    save = button('Save changes', undefined, 'primary');
    save.type = 'submit';
    save.disabled = state.integrationCatalogLoading;
    actions.append(save);
  }
  form.append(actions);
  if (readOnly || state.integrationCatalogLoading) {
    form.querySelectorAll('input,select,textarea').forEach((input) => {
      input.disabled = true;
    });
    form.querySelectorAll('[data-multi-edit],[data-multi-remove]').forEach((input) => {
      input.disabled = true;
    });
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (readOnly || !save || state.busy || state.integrationCatalogLoading) return;
    const parts = new FormData(form).getAll('projects');
    try {
      if (parts.length > 100) throw new Error('Select at most 100 GitLab projects.');
      if (
        parts.some((value) => !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
      )
        throw new Error('Choose only positive numeric GitLab projects.');
      if (new Set(parts).size !== parts.length)
        throw new Error('A GitLab project may only be selected once.');
      state.integrationFormOpen = false;
      save.disabled = true;
      cancel.disabled = true;
      await change({
        revision: state.board.workspace.revision,
        kind: 'integration.save',
        integration: { instance: state.board.connector_instance, projects: parts.map(Number) },
      });
      state.integrationCatalogError = '';
      state.integrationCatalogLoading = false;
      state.integrationCatalogRequest++;
      render();
    } catch (submitError) {
      state.integrationFormOpen = true;
      setErrorText(
        error,
        `${submitError.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`,
      );
      save.disabled = false;
      cancel.disabled = false;
      renderControls();
    }
  });
  return form;
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
