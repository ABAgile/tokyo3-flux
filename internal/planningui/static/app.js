import {
  $,
  el,
  button,
  options,
  svgNode,
  syncAttributes,
  field,
  uid,
  noAutofill,
} from './modules/dom.js';
import { api, apiRevalidated, requestKey } from './modules/api.js';
import { itemPayloadFromForm } from './modules/item-command.js';
import {
  labelForeground,
  workspaceLabel,
  workspaceHistoryLabel,
  columnWIPLabel,
} from './modules/format.js';
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
  gitLabWritable,
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
  projectName,
  itemProjectIDs,
  projectBadges,
  labelInfo,
  labelBadge,
  styleLabelOptions,
  done,
  findItem,
  blocked,
  scopeItems,
} from './modules/items.js';
import { renderControls } from './modules/controls.js';
import {
  memberInfo,
  memberName,
  memberListingInfo,
  avatarView,
  itemParticipants,
  participantInfo,
  participantStack,
} from './modules/people.js';
import { patchNode, keyedNodeKey, reconcileKeyedChildren } from './modules/reconcile.js';
import { helpPopover, multiSelect, labelColorPicker } from './modules/multi-select.js';
import {
  itemDateStatus,
  dueDateBadge,
  positionCardDueBadge,
  positionListDueBadge,
  editorDueBadgeHost,
  appendEditorDueBadge,
  refreshDueDateBadges,
  scheduleOverdueRefresh,
} from './modules/due-dates.js';
import {
  gitlabProjectLabel,
  integrationProjectEntries,
  memberUserEntries,
  loadGitLabUsers,
  loadGitLabProjects,
  approvedGitLabProjectEntries,
  validGitLabMergeRequestCatalog,
  mergeRequestEntries,
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
  singleFilterValue,
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
import {
  receiptRevision,
  change,
  UNDO_TTL,
  clearUndo,
  offerUndo,
  quick,
  runSequence,
} from './modules/commands.js';
import {
  isFileTransfer,
  attachmentsLoaded,
  attachmentCount,
  ensureAttachments,
  itemFileDropZone,
  attachmentPaperclip,
  attachmentTileLink,
  renderItemAttachments,
  initAttachmentTooltips,
} from './modules/item-attachments.js';
import { closeEditor, openEditor } from './modules/dialog.js';
import { makeDraggable, dropZone } from './modules/drag.js';
import {
  linkDisplayName,
  cardLinkView,
  cardObservationIcon,
  linkIdentitySignature,
  patchObservationIcon,
  patchObservationLink,
  patchRefreshControl,
  patchObservationUI,
  showLinks,
  initObservationTooltips,
} from './modules/gitlab.js';
import { renderItemComments } from './modules/item-comments.js';
import {
  workspacePreference,
  persistWorkspaceURL,
  planningURLState,
  persistPlanningURL,
  setSharedItem,
  copyCardLink,
  openSharedItem,
  applyHistoryNavigation,
  applyPlanningURLState,
} from './modules/url-state.js';
// Late-bound calls from feature modules back into the shell.
Object.assign(hooks, {
  chooseWorkspace,
  closeDetail,
  editItemModal,
  openItemDetail,
  persistPlanningURL,
  placeFilters,
  refresh,
  render,
  renderContent,
  resetBurndown,
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
function bulkTargets() {
  return [...state.bulkSelection].map(findItem).filter((item) => item && !item.archived);
}
function bulkItemUpdate(item, patch) {
  return {
    kind: 'item.update',
    target: item.id,
    item: { ...item, project_id: undefined, attachments: undefined, ...patch },
  };
}
async function runBulk(label, plan, undoFor) {
  const targets = bulkTargets();
  if (!targets.length) {
    notice('Select at least one work item first.', true);
    return;
  }
  const commands = targets.map(plan).filter(Boolean);
  const undo = undoFor?.(targets);
  state.bulkSelection.clear();
  const ok = await runSequence(label, commands);
  if (ok && commands.length && undo)
    offerUndo(`${undo.text} · undo is available for ${UNDO_TTL / 1000} seconds`, undo.commands);
}
function openBulkDialog(title, saveText, build, plan, label, undoFor) {
  state.editorReturn = undefined;
  $('editor-title').textContent = title;
  $('editor-form').classList.remove('item-editor-form');
  $('editor-form')
    .querySelectorAll('[data-item-footer]')
    .forEach((node) => node.remove());
  $('fields').replaceChildren();
  $('form-error').textContent = '';
  $('save').hidden = false;
  $('save').disabled = false;
  $('save').textContent = saveText;
  build($('fields'));
  $('editor-form').onsubmit = async (event) => {
    event.preventDefault();
    if (state.busy) return;
    $('form-error').textContent = '';
    let apply;
    try {
      apply = plan(new FormData($('editor-form')));
    } catch (error) {
      $('form-error').textContent = error.message;
      return;
    }
    $('editor').close();
    await runBulk(label, apply, undoFor);
  };
  $('editor').showModal();
}
function bulkAssign() {
  const count = bulkTargets().length;
  openBulkDialog(
    'Assign selected work',
    'Assign items',
    (fields) => {
      fields.append(
        helpText(
          `Set one assignee on ${count} selected work item${count === 1 ? '' : 's'}. Existing assignees are replaced.`,
        ),
      );
      field(fields, 'assignee', 'Assignee', '', 'text', [
        ['', 'Unassigned'],
        ...state.board.members.map((member) => [member.subject, memberName(member.subject)]),
      ]);
    },
    (data) => {
      const assignee = String(data.get('assignee') || '');
      return (item) =>
        item.assignee === assignee ? undefined : bulkItemUpdate(item, { assignee });
    },
    'Assign',
  );
}
function bulkSprint() {
  const open = state.board.sprints.filter((sprint) => sprint.state !== 'closed');
  const count = bulkTargets().length;
  openBulkDialog(
    'Add selected work to a sprint',
    'Add to sprint',
    (fields) => {
      if (!open.length) {
        fields.append(emptyState('No open sprint is available. Plan a sprint first.'));
        $('save').hidden = true;
        return;
      }
      fields.append(
        helpText(
          `Add ${count} selected work item${count === 1 ? '' : 's'} to one open sprint. Existing sprint memberships are kept.`,
        ),
      );
      field(
        fields,
        'sprint',
        'Open sprint',
        open[0].id,
        'text',
        open.map((sprint) => [sprint.id, `${sprint.name} (${sprint.state})`]),
      );
    },
    (data) => {
      const sprint = String(data.get('sprint') || '');
      if (!open.some((value) => value.id === sprint)) throw new Error('Choose an open sprint.');
      return (item) =>
        item.sprint_ids.includes(sprint)
          ? undefined
          : bulkItemUpdate(item, { sprint_ids: [...item.sprint_ids, sprint] });
    },
    'Add to sprint',
  );
}
function bulkLabel() {
  const count = bulkTargets().length;
  openBulkDialog(
    'Add a label to selected work',
    'Add label',
    (fields) => {
      if (!state.board.labels.length) {
        fields.append(emptyState('No workspace label exists yet. Create one in the Labels view.'));
        $('save').hidden = true;
        return;
      }
      fields.append(
        helpText(
          `Add one workspace label to ${count} selected work item${count === 1 ? '' : 's'}. Existing labels are kept.`,
        ),
      );
      styleLabelOptions(
        field(
          fields,
          'label',
          'Label',
          state.board.labels[0].name,
          'text',
          state.board.labels.map((label) => [label.name, label.name]),
        ),
      );
    },
    (data) => {
      const label = String(data.get('label') || '');
      if (!state.board.labels.some((value) => value.name === label))
        throw new Error('Choose a workspace label.');
      return (item) =>
        item.labels.includes(label)
          ? undefined
          : bulkItemUpdate(item, { labels: [...item.labels, label] });
    },
    'Add label',
  );
}
function bulkArchive() {
  const count = bulkTargets().length;
  openBulkDialog(
    'Archive selected work',
    'Archive items',
    (fields) => {
      fields.append(
        el(
          'p',
          `Archive ${count} selected work item${count === 1 ? '' : 's'} and remove them from all open sprints? History is retained and each item can be restored.`,
        ),
      );
      field(fields, 'reason', 'Archive rationale (optional)', '', 'textarea').maxLength = 4000;
    },
    (data) => {
      const reason = String(data.get('reason') || '');
      return (item) => ({ kind: 'item.archive', target: item.id, reason });
    },
    'Archive',
    (targets) => ({
      text: `Archived ${targets.length} work item${targets.length === 1 ? '' : 's'}`,
      commands: targets.map((item) => ({
        kind: 'item.restore',
        target: item.id,
        restore_sprint_ids: [...(item.sprint_ids || [])],
      })),
    }),
  );
}
function bulkSelectableIDs(items) {
  return items.filter((item) => !item.archived).map((item) => item.id);
}
function pruneBulkSelection(items) {
  const selectable = new Set(bulkSelectableIDs(items));
  state.bulkSelection.forEach((id) => {
    if (!selectable.has(id)) state.bulkSelection.delete(id);
  });
}
function renderBulkBar(bar, items) {
  if (!bar) return;
  const ids = bulkSelectableIDs(items);
  if (!state.bulkSelection.size || state.board.role === 'viewer') {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  const actions = el('div', undefined, 'actions bulk-actions');
  actions.append(
    writeButton('Assign…', bulkAssign),
    writeButton('Add to sprint…', bulkSprint),
    writeButton('Add label…', bulkLabel),
    writeButton('Archive…', bulkArchive, 'danger'),
  );
  if (state.bulkSelection.size < ids.length)
    actions.append(
      button(`Select all ${ids.length} shown`, () => {
        ids.forEach((id) => state.bulkSelection.add(id));
        renderContent();
      }),
    );
  actions.append(
    button('Clear selection', () => {
      state.bulkSelection.clear();
      renderContent();
    }),
  );
  bar.hidden = false;
  bar.replaceChildren(
    el('span', `${state.bulkSelection.size} of ${ids.length} shown selected`, 'bulk-count'),
    actions,
  );
}
function refreshBulkBar() {
  const bar = document.querySelector('[data-bulk-bar]');
  if (bar) renderBulkBar(bar, filteredItems());
}
document.addEventListener('dragover', (e) => {
  if (isFileTransfer(e.dataTransfer)) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (isFileTransfer(e.dataTransfer)) e.preventDefault();
});
function renderProjectSummary() {
  const summary = $('project-summary');
  const projectID = singleFilterValue('project');
  const project = state.board.projects.find((value) => value.id === projectID);
  if (state.view !== 'board' || !project || ['all', 'none'].includes(projectID)) {
    summary.hidden = true;
    summary.replaceChildren();
    return;
  }
  const items = state.board.items.filter(
    (item) => !item.archived && itemProjectIDs(item).includes(projectID),
  );
  const openSprints = state.board.sprints.filter(
    (sprint) =>
      sprint.state !== 'closed' && items.some((item) => item.sprint_ids.includes(sprint.id)),
  );
  const active = openSprints.filter((sprint) => sprint.state === 'active');
  const completed = items.filter(done).length;
  const blockedCount = items.filter(blocked).length;
  const unscheduled = items.filter((item) => !done(item) && !item.sprint_ids.length).length;
  const head = el('div', undefined, 'project-summary-head');
  const intro = el('div', undefined, 'project-summary-title');
  intro.append(
    el('p', 'PROJECT LENS', 'eyebrow'),
    el('h2', `${project.name} project`),
    helpText('Current work only · archived history is excluded.'),
  );
  head.append(intro);
  const metrics = metricList(
    [
      [items.length, 'In scope'],
      [completed, 'Done'],
      [blockedCount, 'Blocked'],
      [unscheduled, 'Unscheduled'],
    ],
    'project-summary-metrics',
  );
  const coverage = el('div', undefined, 'project-sprint-coverage');
  coverage.append(el('span', 'Active sprint coverage', 'project-sprint-coverage-label'));
  active.forEach((sprint) => {
    const count = items.filter((item) => item.sprint_ids.includes(sprint.id)).length;
    coverage.append(el('span', `${sprint.name} · ${count}`, 'badge'));
  });
  if (unscheduled) coverage.append(el('span', `Backlog · ${unscheduled}`, 'badge'));
  if (!active.length && !unscheduled) coverage.append(el('span', 'None', 'muted'));
  summary.hidden = false;
  summary.setAttribute('aria-label', `${project.name} project summary`);
  summary.replaceChildren(head, metrics, coverage);
}
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
function cardRenderSignature(item, links) {
  const linkIdentity = links.map((link) => ({
    id: link.id,
    project: link.project,
    kind: link.kind,
    number: link.number,
    items: link.items,
  }));
  const due = itemDateStatus(item);
  const itemView = {
    id: item.id,
    title: item.title,
    column_id: item.column_id,
    project_id: item.project_id,
    project_ids: itemProjectIDs(item),
    assignee: item.assignee,
    labels: item.labels,
    sprint_ids: item.sprint_ids,
    archived: item.archived,
    due_date: item.due_date,
    overdue: due?.overdue || false,
    attachments: attachmentsLoaded(item) ? item.attachments : null,
    attachment_count: attachmentCount(item),
  };
  return JSON.stringify({
    item: itemView,
    links: linkIdentity,
    projects: itemProjectIDs(item).map(projectName),
    assignee: memberInfo(item.assignee),
    participants: itemParticipants(item).map((participant) => [
      participant.subject,
      participant.roles,
      participantInfo(participant).name,
      participantInfo(participant).avatarURL,
    ]),
    sprints: item.sprint_ids.map((id) => state.board.sprints.find((s) => s.id === id)?.name || id),
    labels: item.labels.map(labelInfo),
    blocked: blocked(item),
  });
}
function card(item, peers) {
  const c = el('article', undefined, 'card');
  const top = el('div', undefined, 'card-top');
  const title = button(item.title, () => editItem(item), 'card-title');
  title.dataset.focusKey = `item:${item.id}:title`;
  top.append(title);
  c.dataset.item = item.id;
  const due = itemDateStatus(item);
  c.classList.toggle('is-overdue', !!due?.overdue);
  makeDraggable(c, 'card', item.id, item.title);
  c.tabIndex = 0;
  c.setAttribute('aria-label', `Open work item ${item.title}; draggable`);
  itemFileDropZone(c, item);
  c.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.target.closest?.('a,button,input,select,textarea,summary'))
      return;
    editItem(item);
  });
  c.addEventListener('keydown', (event) => {
    if (event.target !== c || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    editItem(item);
  });
  dropZone(c, 'card', (id, after) => {
    const current = state.board.items.find((value) => value.id === item.id) || item;
    const currentPeers = filteredItems().filter((value) => value.column_id === current.column_id);
    const index = currentPeers.findIndex((value) => value.id === current.id);
    return {
      kind: 'item.move',
      target: id,
      destination: current.column_id,
      before: after ? currentPeers[index + 1]?.id || '' : current.id,
    };
  });
  const meta = el('div', undefined, 'card-meta');
  const projects = el('div', undefined, 'card-projects');
  projects.append(...projectBadges(item));
  meta.append(projects, participantStack(item));
  c.append(top, meta);
  const sprintTags = el('div', undefined, 'tags');
  sprintTags.dataset.cardSection = 'sprints';
  item.sprint_ids.forEach((id) => {
    const tag = el(
      'span',
      state.board.sprints.find((s) => s.id === id)?.name || id,
      'badge badge-sprint',
    );
    tag.dataset.sprintId = id;
    sprintTags.append(tag);
  });
  c.append(sprintTags);
  const tags = el('div', undefined, 'tags');
  tags.dataset.cardSection = 'labels';
  item.labels.forEach((l) => tags.append(labelBadge(l)));
  if (blocked(item)) tags.append(el('span', 'Blocked by dependency', 'badge warning'));
  const dueBadge = dueDateBadge(item);
  if (dueBadge) tags.append(dueBadge);
  if (item.archived) tags.append(el('span', 'Archived', 'badge'));
  c.append(tags);
  if (due?.overdue && dueBadge) positionCardDueBadge(dueBadge, true);
  if (item.archived) {
    const controls = el('div', undefined, 'card-controls');
    controls.append(
      writeButton('Restore item', () => quick({ kind: 'item.restore', target: item.id })),
    );
    c.append(controls);
  }
  const links = state.board.links.filter((l) => l.items.includes(item.id));
  if (links.length) {
    const linkSection = el('div', undefined, 'card-links-section');
    linkSection.setAttribute('role', 'group');
    linkSection.setAttribute('aria-label', 'GitLab links');
    const linkHead = el('div', undefined, 'card-links-head');
    const linkLabel = el('span', `GitLab links · ${links.length}`, 'card-links-label');
    linkLabel.dataset.renderSignature = `links:${links.length}`;
    const details = button('View observations', () => showLinks(item), 'card-link-details');
    details.dataset.renderSignature = 'observations-action';
    details.dataset.focusKey = `item:${item.id}:observations`;
    details.setAttribute('aria-label', `View GitLab details · ${links.length}`);
    details.title = 'Show linked GitLab observations';
    linkHead.append(linkLabel, details);
    const linkList = el('div', undefined, 'card-links');
    linkList.setAttribute('aria-label', 'GitLab links');
    links.forEach((link) => {
      if (link.kind === 'mr')
        linkList.append(cardObservationIcon(link, `item:${item.id}:observation:${link.id}`));
      linkList.append(cardLinkView(link, `item:${item.id}:link:${link.id}`));
    });
    linkSection.append(linkHead, linkList);
    c.append(linkSection);
  }
  const total = attachmentCount(item);
  if (total) {
    const attachmentList = el('details', undefined, 'card-attachments');
    attachmentList.dataset.stateKey = `item:${item.id}:attachments`;
    const count = `${total} attachment${total === 1 ? '' : 's'}`;
    attachmentList.setAttribute('aria-label', count);
    const attachmentHead = el('summary', undefined, 'card-attachments-head');
    const attachmentToggle = el('span', undefined, 'card-attachments-toggle');
    attachmentToggle.setAttribute('aria-hidden', 'true');
    attachmentHead.append(
      attachmentPaperclip(),
      el('span', 'Attachments', 'card-attachments-label'),
      el('span', String(total), 'card-attachments-count'),
      attachmentToggle,
    );
    const attachmentOptions = el('div', undefined, 'card-attachment-list');
    // Expanding the summary is what pays for the metadata read.
    if (attachmentsLoaded(item))
      item.attachments.forEach((attachment) => {
        const link = attachmentTileLink(item, attachment);
        link.classList.add('card-attachment-option');
        attachmentOptions.append(link);
      });
    else attachmentOptions.append(emptyState('Loading attachments…'));
    attachmentList.addEventListener('toggle', () => {
      if (attachmentList.open) void ensureAttachments(item);
    });
    attachmentList.append(attachmentHead, attachmentOptions);
    c.append(attachmentList);
  }
  c.dataset.renderSignature = cardRenderSignature(item, links);
  return c;
}
function renderColumn(col, items) {
  const section = el('section', undefined, 'column');
  section.dataset.column = col.id;
  section.setAttribute('aria-label', col.name);
  const peers = items.filter((item) => item.column_id === col.id);
  const total = state.board.items.filter(
    (item) => !item.archived && item.column_id === col.id,
  ).length;
  const head = el('div', undefined, 'column-head');
  head.dataset.renderSignature = JSON.stringify({
    id: col.id,
    name: col.name,
    category: col.category,
    wip: col.wip,
    shown: peers.length,
    total,
  });
  head.append(
    el('h3', col.name),
    el('small', `${peers.length} shown · ${columnWIPLabel(col, total)}`),
  );
  makeDraggable(head, 'list', col.id, col.name);
  dropZone(
    section,
    'card',
    (id) => ({ kind: 'item.move', target: id, destination: col.id }),
    'end',
  );
  dropZone(
    section,
    'list',
    (id, after) => ({
      kind: 'column.rank',
      target: id,
      before: after
        ? state.board.columns[state.board.columns.findIndex((value) => value.id === col.id) + 1]
            ?.id || ''
        : col.id,
    }),
    'x',
  );
  section.append(head);
  appendCards(section, peers);
  if (!peers.length) {
    section.append(emptyState('No work here'));
  }
  section.dataset.renderSignature = JSON.stringify({
    id: col.id,
    name: col.name,
    category: col.category,
    wip: col.wip,
  });
  return section;
}
function cardChildKey(node) {
  if (node.classList.contains('card-top')) return 'top';
  if (node.classList.contains('card-meta')) return 'meta';
  if (node.classList.contains('tags')) return `tags:${node.dataset.cardSection || ''}`;
  if (node.classList.contains('card-links-section') || node.classList.contains('card-links'))
    return 'links';
  if (node.classList.contains('card-attachments')) return 'attachments';
  if (node.classList.contains('card-controls')) return 'controls';
  return node.className || node.tagName;
}
function cardLinkChildKey(node) {
  if (node.dataset.observation === 'status-icon') return `status:${node.dataset.linkId}`;
  if (node.dataset.observation === 'link') return `link:${node.dataset.linkId}`;
  return 'details';
}
function patchCardLinksHead(target, next) {
  syncAttributes(target, next);
  reconcileKeyedChildren(
    target,
    [...next.children],
    (node) => (node.classList.contains('card-links-label') ? 'label' : 'details'),
    patchNode,
  );
  return target;
}
function patchCardLinksSection(target, next) {
  syncAttributes(target, next);
  const currentHead = target.querySelector('.card-links-head');
  const nextHead = next.querySelector('.card-links-head');
  if (currentHead && nextHead) patchCardLinksHead(currentHead, nextHead);
  const currentLinks = target.querySelector('.card-links');
  const nextLinks = next.querySelector('.card-links');
  if (currentLinks && nextLinks) patchCardLinks(currentLinks, nextLinks);
  return target;
}
function patchCardLinks(target, next) {
  syncAttributes(target, next);
  reconcileKeyedChildren(target, [...next.children], cardLinkChildKey, (current, fresh) => {
    const link = state.board.links.find((value) => value.id === fresh.dataset.linkId);
    if (link && fresh.dataset.observation === 'status-icon')
      return patchObservationIcon(current, link);
    if (link && fresh.dataset.observation === 'link') return patchObservationLink(current, link);
    return patchNode(current, fresh);
  });
  return target;
}
function patchCardAttachments(target, next) {
  syncAttributes(target, next);
  const currentHead = target.firstElementChild;
  const nextHead = next.firstElementChild;
  if (currentHead && nextHead) patchNode(currentHead, nextHead);
  const currentList = target.querySelector('.card-attachment-list');
  const nextList = next.querySelector('.card-attachment-list');
  if (currentList && nextList) {
    syncAttributes(currentList, nextList);
    reconcileKeyedChildren(
      currentList,
      [...nextList.children],
      (node) => `attachment:${node.dataset.attachmentId || node.textContent}`,
      patchNode,
    );
  }
  return target;
}
function patchCardTags(target, next) {
  syncAttributes(target, next);
  reconcileKeyedChildren(
    target,
    [...next.children],
    (node) =>
      node.dataset.sprintId
        ? `sprint:${node.dataset.sprintId}`
        : node.dataset.label
          ? `label:${node.dataset.label}`
          : `state:${node.textContent}`,
    patchNode,
  );
  return target;
}
function patchCard(target, next) {
  if (target === next) return target;
  if (target.dataset.renderSignature === next.dataset.renderSignature) {
    const currentLinks = target.querySelector('.card-links-section');
    const nextLinks = next.querySelector('.card-links-section');
    if (currentLinks && nextLinks) patchCardLinksSection(currentLinks, nextLinks);
    return target;
  }
  syncAttributes(target, next);
  reconcileKeyedChildren(target, [...next.children], cardChildKey, (current, fresh) => {
    if (fresh.classList.contains('card-links-section'))
      return patchCardLinksSection(current, fresh);
    if (fresh.classList.contains('card-links')) return patchCardLinks(current, fresh);
    if (fresh.classList.contains('card-attachments')) return patchCardAttachments(current, fresh);
    if (fresh.classList.contains('tags')) return patchCardTags(current, fresh);
    return patchNode(current, fresh);
  });
  return target;
}
function patchColumn(target, next, cardPool) {
  syncAttributes(target, next);
  reconcileKeyedChildren(
    target,
    [...next.children],
    keyedNodeKey,
    (current, fresh) =>
      fresh.dataset.item ? patchCard(current, fresh) : patchNode(current, fresh),
    (key) => (key.startsWith('item:') ? cardPool.get(key.slice('item:'.length)) : undefined),
  );
}
function renderBoardContent(content, items) {
  const next = contentRoot('div', 'board', 'board');
  state.board.columns.forEach((column) => next.append(renderColumn(column, items)));
  const current = content.firstElementChild;
  if (!current || current.dataset.contentView !== 'board') {
    content.replaceChildren(next);
    return;
  }
  const cardPool = new Map(
    [...current.querySelectorAll('.card')].map((node) => [node.dataset.item, node]),
  );
  reconcileKeyedChildren(
    current,
    [...next.children],
    (node) => `column:${node.dataset.column}`,
    (target, fresh) => patchColumn(target, fresh, cardPool),
  );
}
function renderCardListContent(content, items) {
  const next = contentRoot('div', 'list', `list:${state.view}`);
  appendCards(next, items);
  if (!items.length)
    next.append(
      emptyState(
        state.view === 'board' && $('scope').value === 'backlog'
          ? 'Backlog is clear. Create work without a sprint to plan what comes next.'
          : 'No matching work.',
      ),
    );
  const current = content.firstElementChild;
  if (!current || current.dataset.contentView !== next.dataset.contentView) {
    content.replaceChildren(next);
    return;
  }
  reconcileKeyedChildren(current, [...next.children], keyedNodeKey, (target, fresh) =>
    fresh.dataset.item ? patchCard(target, fresh) : patchNode(target, fresh),
  );
}
function listCell(label, className) {
  const cell = el('div', undefined, `list-cell ${className || ''}`.trim());
  cell.dataset.label = label;
  cell.append(el('span', label, 'list-cell-label'));
  return cell;
}
function listTableHeader() {
  const header = el('div', undefined, 'list-table-head');
  ['Title', 'Project', 'Assignee', 'Labels', 'Sprints', 'Links / Status'].forEach((label) =>
    header.append(el('span', label, 'list-table-heading')),
  );
  return header;
}
function listRow(item) {
  const row = el('article', undefined, 'list-row');
  row.dataset.item = item.id;
  row.dataset.focusKey = `item:${item.id}:list-row`;
  row.tabIndex = 0;
  row.setAttribute('aria-label', `Open work item ${item.title}`);
  const due = itemDateStatus(item);
  row.classList.toggle('is-overdue', !!due?.overdue);
  row.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.target.closest?.('a,button,input,select,textarea,summary'))
      return;
    selectItem(item.id, row);
  });
  row.addEventListener('keydown', (event) => {
    if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    selectItem(item.id, row);
  });
  makeDraggable(row, 'card', item.id, item.title);
  itemFileDropZone(row, item);
  row.setAttribute('aria-label', `Open work item ${item.title}; draggable`);
  dropZone(row, 'card', (id, after) => {
    const current = state.board.items.find((value) => value.id === item.id) || item;
    const currentPeers = filteredItems().filter((value) => value.column_id === current.column_id);
    const index = currentPeers.findIndex((value) => value.id === current.id);
    return {
      kind: 'item.move',
      target: id,
      destination: current.column_id,
      before: after ? currentPeers[index + 1]?.id || '' : current.id,
    };
  });
  const title = listCell('Title', 'list-cell-title');
  const titleDetails = el('div', undefined, 'list-row-title-details');
  const titleLine = el('div', undefined, 'list-row-title-line');
  const bulkSelected = state.bulkSelection.has(item.id);
  if (state.board.role !== 'viewer' && !item.archived) {
    const toggle = el('input');
    toggle.id = `bulk-select-${item.id}`;
    toggle.type = 'checkbox';
    toggle.className = 'list-row-select';
    toggle.checked = bulkSelected;
    toggle.disabled = state.busy || state.loading;
    toggle.dataset.focusKey = `item:${item.id}:bulk-select`;
    toggle.setAttribute('aria-label', `Select ${item.title} for bulk actions`);
    toggle.addEventListener('click', (event) => event.stopPropagation());
    toggle.addEventListener('change', () => {
      if (toggle.checked) state.bulkSelection.add(item.id);
      else state.bulkSelection.delete(item.id);
      row.classList.toggle('is-bulk-selected', toggle.checked);
      refreshBulkBar();
    });
    titleLine.append(toggle);
  }
  const titleButton = button(item.title, () => selectItem(item.id, row), 'list-row-title');
  titleButton.dataset.focusKey = `item:${item.id}:list-title`;
  titleLine.append(titleButton);
  titleDetails.append(titleLine);
  if (due?.overdue) titleDetails.append(dueDateBadge(item));
  title.append(titleDetails);
  const project = listCell('Project', 'list-cell-project');
  const projectValue = el('span', undefined, 'list-row-project');
  projectValue.append(...projectBadges(item));
  project.append(projectValue);
  const status = listCell('Links / Status', 'list-cell-status');
  const statusContent = el('div', undefined, 'list-row-status-content');
  const statusBadges = el('div', undefined, 'list-row-status-badges');
  if (blocked(item)) statusBadges.append(el('span', 'Blocked', 'badge warning'));
  if (due && !due.overdue) {
    const dueBadge = dueDateBadge(item);
    if (dueBadge) statusBadges.append(dueBadge);
  }
  if (item.archived) statusBadges.append(el('span', 'Archived', 'badge'));
  if (statusBadges.childElementCount || due?.overdue) statusContent.append(statusBadges);
  const links = state.board.links.filter((link) => link.items.includes(item.id));
  if (links.length) {
    const linkIndicator = el('div', undefined, 'list-row-indicator list-row-links');
    linkIndicator.setAttribute(
      'aria-label',
      `${links.length} GitLab link${links.length === 1 ? '' : 's'}`,
    );
    const linkHead = el('div', undefined, 'card-links-head');
    const linkLabel = el('span', `GitLab links · ${links.length}`, 'card-links-label');
    const observationLink = button(
      'View observations',
      () => showLinks(item),
      'card-link-details list-row-observation-link',
    );
    observationLink.dataset.focusKey = `item:${item.id}:list-observations`;
    observationLink.setAttribute(
      'aria-label',
      `View observations · ${links.length} GitLab link${links.length === 1 ? '' : 's'}`,
    );
    observationLink.title = 'Show linked GitLab observations';
    linkHead.append(linkLabel, observationLink);
    linkIndicator.append(linkHead);
    links.forEach((link) => {
      const line = el('span', undefined, 'list-row-link-line');
      if (link.kind === 'mr')
        line.append(cardObservationIcon(link, `item:${item.id}:list-observation:${link.id}`));
      line.append(cardLinkView(link, `item:${item.id}:list-link:${link.id}`));
      linkIndicator.append(line);
    });
    statusContent.append(linkIndicator);
  }
  const attachmentTotal = attachmentCount(item);
  if (attachmentTotal) {
    const attachmentIndicator = el('span', undefined, 'list-row-indicator list-row-attachments');
    attachmentIndicator.setAttribute(
      'aria-label',
      `${attachmentTotal} attachment${attachmentTotal === 1 ? '' : 's'}`,
    );
    attachmentIndicator.append(attachmentPaperclip(), el('span', String(attachmentTotal)));
    statusContent.append(attachmentIndicator);
  }
  if (statusContent.childElementCount) status.append(statusContent);
  else status.append(el('span', '—', 'list-cell-empty'));
  // The list shows the same participant aggregate as a card, and keeps the
  // assignee's name in text so the column stays scannable as a table.
  const people = listCell('People', 'list-cell-people');
  const peopleContent = el('div', undefined, 'list-row-people');
  peopleContent.append(
    participantStack(item),
    el('span', memberName(item.assignee), 'list-row-assignee-name'),
  );
  people.append(peopleContent);
  const labels = listCell('Labels', 'list-cell-labels');
  item.labels.forEach((label) => labels.append(labelBadge(label)));
  if (labels.childElementCount === 1) labels.append(el('span', '—', 'list-cell-empty'));
  const sprints = listCell('Sprints', 'list-cell-sprints');
  item.sprint_ids.forEach((id) =>
    sprints.append(
      el('span', state.board.sprints.find((s) => s.id === id)?.name || id, 'badge badge-sprint'),
    ),
  );
  if (sprints.childElementCount === 1) sprints.append(el('span', '—', 'list-cell-empty'));
  row.append(title, project, people, labels, sprints, status);
  if (due?.overdue) positionListDueBadge(row.querySelector('.badge-due'), true);
  row.classList.toggle('is-selected', state.selectedItemID === item.id);
  row.classList.toggle('is-bulk-selected', bulkSelected);
  row.dataset.renderSignature = `${cardRenderSignature(item, links)}|selected:${state.selectedItemID === item.id}|bulk:${bulkSelected}`;
  return row;
}
function listSection(column, items) {
  const section = el('details', undefined, 'list-section');
  section.dataset.column = column.id;
  section.open = true;
  section.setAttribute('aria-label', column.name);
  const peers = items.filter((item) => item.column_id === column.id);
  const total = state.board.items.filter(
    (item) => !item.archived && item.column_id === column.id,
  ).length;
  const head = el('summary', undefined, 'list-section-head');
  head.dataset.renderSignature = JSON.stringify({
    id: column.id,
    name: column.name,
    category: column.category,
    wip: column.wip,
    shown: peers.length,
    total,
  });
  const title = el('span', undefined, 'list-section-title');
  title.append(el('h3', column.name));
  const summary = el(
    'span',
    `${peers.length} shown · ${columnWIPLabel(column, total)}`,
    'list-section-summary',
  );
  head.append(title, summary);
  makeDraggable(head, 'list', column.id, column.name);
  dropZone(
    section,
    'card',
    (id) => ({ kind: 'item.move', target: id, destination: column.id }),
    'end',
  );
  dropZone(
    section,
    'list',
    (id, after) => ({
      kind: 'column.rank',
      target: id,
      before: after
        ? state.board.columns[state.board.columns.findIndex((value) => value.id === column.id) + 1]
            ?.id || ''
        : column.id,
    }),
    'x',
  );
  const body = el('div', undefined, 'list-section-body');
  body.append(...peers.map((item) => listRow(item)));
  if (!peers.length) body.append(emptyState('No work here'));
  section.append(head, body);
  section.dataset.renderSignature = JSON.stringify({
    id: column.id,
    name: column.name,
    category: column.category,
    wip: column.wip,
  });
  return section;
}
function patchListSection(target, next) {
  const expanded = target.open;
  syncAttributes(target, next);
  const currentHead = target.querySelector(':scope > .list-section-head');
  const nextHead = next.querySelector(':scope > .list-section-head');
  if (currentHead && nextHead) patchNode(currentHead, nextHead);
  const currentBody = target.querySelector(':scope > .list-section-body');
  const nextBody = next.querySelector(':scope > .list-section-body');
  if (currentBody && nextBody) {
    syncAttributes(currentBody, nextBody);
    reconcileKeyedChildren(currentBody, [...nextBody.children], keyedNodeKey, (current, fresh) =>
      fresh.dataset.item ? patchNode(current, fresh) : patchNode(current, fresh),
    );
  }
  target.open = expanded;
  return target;
}
function renderListPresentationContent(content, items) {
  const current = content.firstElementChild;
  let layout, sections;
  if (!current || current.dataset.contentView !== 'list:board') {
    layout = contentRoot('div', 'list-detail-layout', 'list:board');
    const list = el('div', undefined, 'planning-list');
    list.dataset.contentView = 'planning-list';
    sections = el('div', undefined, 'list-sections');
    const bar = el('div', undefined, 'bulk-bar');
    bar.dataset.bulkBar = 'true';
    bar.hidden = true;
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Bulk actions');
    list.append(bar, listTableHeader(), sections);
    const pane = createDetailPane();
    layout.append(list, pane);
    content.replaceChildren(layout);
  } else {
    layout = current;
    sections = layout.querySelector(':scope > .planning-list > .list-sections');
  }
  pruneBulkSelection(items);
  const nextSections = state.board.columns.map((column) => listSection(column, items));
  reconcileKeyedChildren(
    sections,
    nextSections,
    (node) => `column:${node.dataset.column}`,
    patchListSection,
  );
  renderBulkBar(layout.querySelector('[data-bulk-bar]'), items);
  syncListSelection();
  updateDetailPaneVisibility();
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
function appendCards(parent, items) {
  items.forEach((i) => parent.append(card(i, items)));
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
const ARCHIVE_PAGE = 50;
function resetArchive() {
  state.archiveItems = [];
  state.archiveOffset = 0;
  state.archiveMore = false;
}
async function loadArchive(reset = false) {
  const offset = reset ? 0 : state.archiveOffset;
  const page = await api(`${state.root}/archive?offset=${offset}&limit=${ARCHIVE_PAGE}`);
  if (!Array.isArray(page)) throw new Error('Archive response is invalid. Refresh to retry.');
  state.archiveItems = reset ? page : [...state.archiveItems, ...page];
  state.archiveOffset = offset + page.length;
  state.archiveMore = page.length === ARCHIVE_PAGE;
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
function itemEditorDraft(form = $('editor-form')) {
  const data = new FormData(form);
  return {
    title: String(data.get('title') || ''),
    description: String(data.get('description') || ''),
    start_date: String(data.get('start_date') || ''),
    end_date: String(data.get('end_date') || ''),
    due_date: String(data.get('due_date') || ''),
    column_id: String(data.get('column_id') || ''),
    project_ids: data.getAll('project_id').filter(Boolean),
    assignee: String(data.get('assignee') || ''),
    sprint_ids: data.getAll('sprint_ids'),
    labels: data.getAll('labels'),
    dependencies: data.getAll('dependencies'),
    link_ids: data.getAll('link_ids'),
  };
}
function resolveGitLabMRURL(value, currentBoard, projects) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Paste a GitLab merge-request URL first.');
  if (
    !currentBoard.connector_instance ||
    currentBoard.connector_instance !== currentBoard.integration.instance
  )
    throw new Error('GitLab link creation is not configured for this workspace.');
  if (!currentBoard.integration.projects.length)
    throw new Error('No approved GitLab projects are available for linking.');
  let target, instance, projectPath;
  try {
    target = new URL(raw);
    instance = new URL(currentBoard.connector_instance);
    projectPath = decodeURIComponent(target.pathname);
  } catch {
    throw new Error('Enter a valid GitLab merge-request URL.');
  }
  if (
    raw.length > 2048 ||
    /[\r\n]/.test(raw) ||
    target.origin !== instance.origin ||
    target.username ||
    target.password
  )
    throw new Error('Use a URL from the configured GitLab instance.');
  const basePath = instance.pathname.replace(/\/+$/, '');
  const prefix = basePath ? basePath + '/' : '/';
  if (!target.pathname.startsWith(prefix))
    throw new Error('That URL is outside the configured GitLab instance.');
  const tail = projectPath.slice(prefix.length);
  const marker = '/-/merge_requests/';
  const markerAt = tail.lastIndexOf(marker);
  const iid = markerAt < 0 ? '' : tail.slice(markerAt + marker.length);
  projectPath = markerAt > 0 ? projectPath.slice(prefix.length, prefix.length + markerAt) : '';
  if (markerAt <= 0 || !/^[1-9][0-9]*$/.test(iid) || !Number.isSafeInteger(Number(iid)))
    throw new Error('Use a canonical GitLab merge-request URL.');
  const approved = new Set(currentBoard.integration.projects.map(String));
  const project = projects.find(
    (value) =>
      approved.has(String(value.id)) &&
      typeof value.path_with_namespace === 'string' &&
      value.path_with_namespace.trim() === projectPath,
  );
  if (!project)
    throw new Error('That merge-request project is not in the approved GitLab project catalog.');
  return { project: Number(project.id), kind: 'mr', number: Number(iid) };
}
async function attachItemGitLabLink(item, link, context) {
  const currentBoard = state.board,
    currentRoot = state.root;
  const form = context?.form || ($('editor').open ? $('editor-form') : undefined);
  const draft = form ? itemEditorDraft(form) : undefined;
  const mode =
    context?.mode ||
    ($('editor').open
      ? 'modal'
      : state.view === 'board' && state.presentation === 'list'
        ? 'detail'
        : 'modal');
  const origin = context?.origin;
  const previous = new Set(
    currentBoard.links.filter((value) => value.items.includes(item.id)).map((value) => value.id),
  );
  if (mode === 'modal') closeEditor();
  try {
    await change({
      revision: currentBoard.workspace.revision,
      kind: 'link.attach',
      target: item.id,
      link,
    });
  } catch (error) {
    if (state.root === currentRoot && state.board) {
      const latest = state.board.items.find((value) => value.id === item.id);
      if (latest && draft) reopenItemEditor(latest, draft, mode, origin);
      notice(error.message, true);
    }
    return;
  }
  if (state.root !== currentRoot || !state.board) return;
  const latest = state.board.items.find((value) => value.id === item.id);
  if (!latest) return;
  const added = state.board.links
    .filter((value) => value.items.includes(item.id) && !previous.has(value.id))
    .map((value) => value.id);
  reopenItemEditor(
    latest,
    draft ? { ...draft, link_ids: [...new Set([...draft.link_ids, ...added])] } : undefined,
    mode,
    origin,
  );
}
function inlineGitLabPaste(parent, item, readOnly, context) {
  const currentBoard = state.board,
    currentRoot = state.root;
  const row = el('div', undefined, 'gitlab-paste-row');
  const input = noAutofill(el('input'));
  input.id = uid('gitlab-mr-url');
  input.type = 'text';
  input.inputMode = 'url';
  input.placeholder = 'Paste GitLab MR URL, then press Enter or click Get';
  input.maxLength = 2048;
  input.setAttribute('aria-label', 'GitLab MR URL');
  const get = button('Get', resolve, 'primary');
  get.dataset.gitlabWrite = 'true';
  get.disabled = readOnly || !gitLabWritable();
  row.append(input, get);
  const status = statusLine();
  const setStatus = (text, error = false) => setStatusText(status, text, error);
  let pending = false;
  async function resolve() {
    if (pending || get.disabled) return;
    const raw = input.value.trim();
    if (!raw) {
      setStatus('Paste a GitLab merge-request URL first.', true);
      input.focus();
      return;
    }
    pending = true;
    get.disabled = true;
    setStatus('Resolving GitLab merge request…');
    try {
      const projects = await loadGitLabProjects(currentRoot);
      if (!row.isConnected || state.board !== currentBoard || state.root !== currentRoot) return;
      const link = resolveGitLabMRURL(raw, currentBoard, projects);
      await attachItemGitLabLink(item, link, context);
    } catch (error) {
      if (row.isConnected) {
        setStatus(error.message, true);
        input.focus();
      }
    } finally {
      pending = false;
      if (row.isConnected) get.disabled = !gitLabWritable();
    }
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      resolve();
    }
  });
  parent.append(row, status);
}
async function addGitLabLink(item, context) {
  const currentBoard = state.board,
    currentRoot = state.root;
  const form = context?.form || ($('editor').open ? $('editor-form') : undefined);
  const draft = form ? itemEditorDraft(form) : undefined;
  const mode =
    context?.mode ||
    ($('editor').open
      ? 'modal'
      : state.view === 'board' && state.presentation === 'list'
        ? 'detail'
        : 'modal');
  const origin = context?.origin;
  if (mode === 'modal') closeEditor();
  let projects = [],
    catalogError = '';
  const returnToCard = () => {
    if (state.root !== currentRoot || !state.board) return;
    const latest = state.board.items.find((value) => value.id === item.id);
    if (!latest) return;
    const previous = new Set(
      currentBoard.links.filter((value) => value.items.includes(item.id)).map((value) => value.id),
    );
    const added = state.board.links
      .filter((value) => value.items.includes(item.id) && !previous.has(value.id))
      .map((value) => value.id);
    const returnDraft = draft
      ? { ...draft, link_ids: [...new Set([...draft.link_ids, ...added])] }
      : undefined;
    reopenItemEditor(latest, returnDraft, mode, origin);
  };
  try {
    projects = await loadGitLabProjects(currentRoot);
  } catch (e) {
    catalogError = e.message;
  }
  if (state.board !== currentBoard || state.root !== currentRoot) return;
  openEditor(
    'Add link',
    (fields) => {
      $('editor-title').append(
        ' ',
        helpPopover(
          'Choose an approved project and use a quick scope or merge-request search. Enter an MR IID only as a final fallback. Flux retrieves the latest pipeline status from the linked MR.',
          'GitLab links',
        ),
      );
      let mrPicker, manualMR;
      let searchTimer;
      let searchGeneration = 0;
      if (catalogError) {
        fields.append(
          errorLine(
            `Could not load the GitLab project list. ${catalogError} Approved project IDs remain available so this link is not blocked by a temporary catalog failure.`,
          ),
        );
      }
      const projectPicker = multiSelect(
        fields,
        'project',
        'Approved GitLab project',
        approvedGitLabProjectEntries(projects),
        [],
        undefined,
        'Choose one approved project. The project list is provided by the configured GitLab connector and is searchable.',
        {
          single: true,
          onChange: (values) => {
            searchGeneration++;
            if (searchTimer) clearTimeout(searchTimer);
            if (!mrPicker) return;
            mrPicker.filter.value = '';
            mrPicker.setEntries([], []);
            if (manualMR) manualMR.value = '';
            mrPicker.setStatus(
              values.length
                ? 'Open the merge-request picker to load results.'
                : 'Select an approved project first.',
            );
          },
        },
      );
      const scope = field(fields, 'scope', 'Quick scope', 'recent', 'text', [
        ['recent', 'Recent merge requests'],
        ['assigned_to_me', 'Assigned to me'],
        ['board_members', 'Assigned to board members'],
      ]);
      const queueMergeRequestSearch = (query, controls) => {
        if (searchTimer) clearTimeout(searchTimer);
        const generation = ++searchGeneration;
        const project = projectPicker.selected()[0];
        if (!project) {
          controls.setEntries([], []);
          controls.setStatus('Select an approved project first.');
          return;
        }
        controls.setStatus('Searching GitLab…');
        searchTimer = setTimeout(async () => {
          try {
            const params = new URLSearchParams({
              project,
              scope: scope.value || 'recent',
              search: query,
            });
            const data = await api(currentRoot + '/gitlab/merge-requests?' + params);
            if (
              generation !== searchGeneration ||
              state.board !== currentBoard ||
              state.root !== currentRoot
            )
              return;
            if (!validGitLabMergeRequestCatalog(data))
              throw new Error('GitLab merge-request results are invalid. Refresh to retry.');
            const selected = controls.selected();
            controls.setEntries(mergeRequestEntries(data, selected), selected);
            controls.setStatus(data.length ? '' : 'No matching merge requests.');
          } catch (e) {
            if (
              generation === searchGeneration &&
              state.board === currentBoard &&
              state.root === currentRoot
            )
              controls.setStatus(e.message);
          }
        }, 250);
      };
      mrPicker = multiSelect(
        fields,
        'merge_request',
        'Merge request',
        [],
        [],
        undefined,
        'After trying a quick scope, search by title or IID. Results are ordered by GitLab update time; selecting one stores only its project-scoped IID.',
        {
          single: true,
          onFilter: queueMergeRequestSearch,
          onOpen: queueMergeRequestSearch,
          onChange: (values) => {
            if (!values.length) return;
            if (manualMR) manualMR.value = '';
          },
        },
      );
      mrPicker.filter.maxLength = 120;
      manualMR = field(fields, 'manual_mr_iid', 'MR IID (optional fallback)', '', 'number');
      manualMR.min = 1;
      manualMR.max = Number.MAX_SAFE_INTEGER;
      manualMR.step = 1;
      scope.addEventListener('change', () => {
        const wasOpen = mrPicker.isOpen();
        searchGeneration++;
        if (searchTimer) clearTimeout(searchTimer);
        mrPicker.filter.value = '';
        mrPicker.setEntries([], []);
        mrPicker.setStatus(
          projectPicker.selected().length
            ? 'Open the merge-request picker to load results.'
            : 'Select an approved project first.',
        );
        if (wasOpen) queueMergeRequestSearch('', mrPicker);
      });
      if (!projects.length && !catalogError && !state.board.integration.projects.length)
        fields.append(helpText('No approved GitLab projects are available for linking.'));
    },
    (data) => {
      const rawProject = String(data.get('project') || '');
      const selectedMR = String(data.get('merge_request') || '');
      const manualIID = String(data.get('manual_mr_iid') || '');
      const rawNumber = selectedMR || manualIID;
      if (!/^[1-9][0-9]*$/.test(rawProject) || !Number.isSafeInteger(Number(rawProject)))
        throw new Error('Choose an approved GitLab project.');
      if (selectedMR && manualIID)
        throw new Error('Select a merge request or enter its IID manually, not both.');
      if (!/^[1-9][0-9]*$/.test(rawNumber) || !Number.isSafeInteger(Number(rawNumber)))
        throw new Error('Select a merge request or enter a positive MR IID.');
      return {
        kind: 'link.attach',
        target: item.id,
        link: { project: Number(rawProject), kind: 'mr', number: Number(rawNumber) },
      };
    },
    false,
    undefined,
    returnToCard,
  );
}
async function reconcileItemLinks(itemID, desiredIDs) {
  const desired = new Set(desiredIDs);
  for (const link of state.board.links.filter(
    (link) => link.items.includes(itemID) && !desired.has(link.id),
  )) {
    await change({
      revision: state.board.workspace.revision,
      kind: 'link.detach',
      target: itemID,
      destination: link.id,
    });
  }
  for (const linkID of desired) {
    if (state.board.links.some((link) => link.id === linkID && link.items.includes(itemID)))
      continue;
    const link = state.board.links.find((value) => value.id === linkID);
    if (!link)
      throw new Error(
        'A selected GitLab link is no longer available. Refresh and reopen the card.',
      );
    await change({
      revision: state.board.workspace.revision,
      kind: 'link.attach',
      target: itemID,
      link: { project: link.project, kind: link.kind, number: link.number },
    });
  }
}
function itemDatesField(parent, item, draft) {
  const group = el('div', undefined, 'multi-select-field date-field');
  const heading = el('span', undefined, 'multi-select-heading');
  heading.append(el('span', 'Dates', 'multi-select-label'));
  const values = el('div', undefined, 'multi-select-values date-field-values');
  const root = el('div', undefined, 'multi-select date-field-content');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Dates');
  const inputs = el('div', undefined, 'date-field-inputs');
  inputs.id = uid('item-dates');
  inputs.hidden = true;
  let editing = false;
  const fields = [
    ['start_date', 'Start date'],
    ['end_date', 'End date'],
    ['due_date', 'Due date'],
  ].map(([name, title]) => {
    const input = field(inputs, name, title, String(draft?.[name] ?? item[name] ?? ''), 'date');
    input.addEventListener('input', renderValues);
    input.addEventListener('change', renderValues);
    return { input, title };
  });
  function clearButton({ input, title }) {
    const clear = button(
      '\u00d7',
      () => {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      },
      'multi-select-remove',
    );
    clear.setAttribute('aria-label', `Clear ${title.toLowerCase()}`);
    return clear;
  }
  function renderValues() {
    values.replaceChildren();
    const [start, end, due] = fields;
    const range = el('span', undefined, 'multi-select-chip date-range-chip');
    range.setAttribute('role', 'group');
    range.setAttribute(
      'aria-label',
      `Start date ${start.input.value || 'not set'}; End date ${end.input.value || 'not set'}`,
    );
    [
      [start, '-'],
      [end, '-'],
    ].forEach(([date, empty], index) => {
      const part = el('span', undefined, 'date-range-part');
      part.append(el('span', date.input.value || empty));
      if (editing && date.input.value) part.append(clearButton(date));
      range.append(part);
      if (!index) range.append(el('span', '\u00b7', 'date-range-separator'));
    });
    values.append(range);
    if (due.input.value) {
      const chip = el('span', undefined, 'multi-select-chip date-due-chip');
      chip.setAttribute('role', 'group');
      chip.setAttribute('aria-label', `Due date ${due.input.value}`);
      chip.append(el('span', `Due \u00b7 ${due.input.value}`));
      if (editing) chip.append(clearButton(due));
      values.append(chip);
    }
  }
  const edit = button('Edit', toggle, 'multi-select-edit');
  edit.dataset.multiEdit = 'true';
  edit.setAttribute('aria-label', 'Edit Dates');
  edit.setAttribute('aria-expanded', 'false');
  edit.setAttribute('aria-controls', inputs.id);
  function toggle() {
    editing = !editing;
    inputs.hidden = !editing;
    edit.textContent = editing ? 'Done' : 'Edit';
    edit.setAttribute('aria-label', editing ? 'Done editing dates' : 'Edit Dates');
    edit.setAttribute('aria-expanded', String(editing));
    renderValues();
    if (editing) fields[0].input.focus();
  }
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (editing) {
      toggle();
      edit.focus();
    }
  });
  const header = el('div', undefined, 'multi-select-header');
  header.append(heading, edit);
  root.append(values, inputs);
  group.append(header, root);
  parent.append(group);
  renderValues();
}
// The card's own planning state, stated explicitly: where it sits, whether it
// is archived or blocked, and which sprints hold it. GitLab entries are labelled
// as cached provider observations, never as authoritative planning state.
function refreshItemStatusSummary(form, item) {
  const current = form.querySelector('.item-status');
  if (!current) return;
  const next = itemStatusSummary(item);
  next.open = current.open;
  current.replaceWith(next);
}
function refreshEditorDueBadge(form, item) {
  const host = editorDueBadgeHost(form);
  if (!host) return;
  const input = form.querySelector('[name="title"]'),
    previous = host.querySelector('.badge-due[data-due-date-badge]');
  if (input?.getAttribute('aria-describedby') === previous?.id)
    input.removeAttribute('aria-describedby');
  previous?.remove();
  if (itemDateStatus(item)?.overdue) {
    const badge = dueDateBadge(item);
    if (badge) {
      badge.id = uid('item-title-overdue');
      input?.setAttribute('aria-describedby', badge.id);
      appendEditorDueBadge(form, badge);
    }
  }
}
function itemStatusSummary(item) {
  const section = el('details', undefined, 'item-status');
  section.dataset.stateKey = `item:${item.id}:status`;
  section.setAttribute('aria-label', 'Current card status');
  const column = state.board.columns.find((value) => value.id === item.column_id);
  const category =
    { todo: 'To do', doing: 'In progress', done: 'Done' }[column?.category] || 'Uncategorised';
  const openSprints = (item.sprint_ids || []).map(
    (id) => state.board.sprints.find((sprint) => sprint.id === id)?.name || id,
  );
  const closedSprints = state.board.closed_scope
    .filter((scope) => scope.item_id === item.id)
    .map(
      (scope) =>
        state.board.sprints.find((sprint) => sprint.id === scope.sprint_id)?.name ||
        scope.sprint_id,
    );
  const links = state.board.links.filter((link) => link.items.includes(item.id));
  // The summary is the whole status in one line; everything that would push the
  // editor down \u2014 sprint history and cached provider observations \u2014 waits behind
  // the disclosure.
  const head = el('summary', undefined, 'item-status-head');
  const badges = el('div', undefined, 'tags item-status-badges');
  // Two orthogonal facts, never merged: where the card sits in the workflow
  // (its column's workspace-defined lifecycle category) and whether the card is
  // still on the board. A Done card is not archived, and an archived card keeps
  // the column it was archived from.
  const workflow = el('span', `${column?.name || item.column_id} \u00b7 ${category}`, 'badge');
  workflow.title = `Board column \u201c${column?.name || item.column_id}\u201d, lifecycle category ${category}`;
  badges.append(workflow);
  // "Live" is the board's own vocabulary for the working set. "In scope" is
  // deliberately avoided here: sprint and project metrics already use it for
  // sprint scope, and this badge sits beside the sprint badge on the same line.
  const presence = el(
    'span',
    item.archived ? 'Archived' : 'Live',
    item.archived ? 'badge warning' : 'badge',
  );
  presence.title = item.archived
    ? 'Archived: removed from the board and from open sprints; history is retained and it can be restored.'
    : 'Live: on the board and not archived. Completion is the column category, and sprint scope is the sprint badge.';
  badges.append(presence);
  if (blocked(item)) badges.append(el('span', 'Blocked by dependency', 'badge warning'));
  const due = itemDateStatus(item);
  if (due && !due.overdue) {
    const dueBadge = dueDateBadge(item);
    if (dueBadge) badges.append(dueBadge);
  }
  badges.append(
    el(
      'span',
      openSprints.length
        ? `${openSprints.length} open sprint${openSprints.length === 1 ? '' : 's'}`
        : 'Backlog',
      'badge',
    ),
  );
  if (links.length)
    badges.append(
      el('span', `${links.length} GitLab link${links.length === 1 ? '' : 's'}`, 'badge'),
    );
  const toggle = el('span', undefined, 'item-status-toggle');
  toggle.setAttribute('aria-hidden', 'true');
  head.append(badges, toggle);
  const body = el('div', undefined, 'item-status-body');
  body.append(
    helpText(
      `Sprints: ${openSprints.length ? openSprints.join(', ') : 'Backlog \u00b7 no open sprint'}${closedSprints.length ? ` \u00b7 Closed sprint history: ${closedSprints.join(', ')}` : ''}`,
    ),
  );
  body.append(
    helpText(
      `Progress is the column\u2019s lifecycle category (To do, In progress, Done), chosen per column in Board setup. ${item.archived ? 'Archived is separate from progress: this card is off the board and out of open sprints, and keeps the column it was archived from.' : 'Done means the card sits in a Done column; it stays on the board until it is archived.'}`,
    ),
  );
  if (links.length) {
    const observations = el('div', undefined, 'item-status-links');
    links.forEach((link) => {
      const row = el('div', undefined, 'item-status-link');
      row.append(
        cardObservationIcon(link, `status:${item.id}:${link.id}`),
        el('span', linkDisplayName(link)),
      );
      observations.append(row);
    });
    body.append(
      helpText('Cached GitLab observations \u00b7 provider data, not Flux planning state'),
      observations,
    );
  }
  section.append(head, body);
  return section;
}
// Restoring from a shared view keeps the same card URL: the link a reader was
// given must keep resolving after the card returns to the board.
async function restoreSharedItem(item, context) {
  if (!writable()) return;
  await quick({ kind: 'item.restore', target: item.id });
  if (!state.board) return;
  if (context?.mode === 'modal') closeEditor();
  else closeDetail({ force: true, focus: false });
  await openSharedItem(item.id);
}
function buildItemEditor(fields, item, draft, readOnly, context, titleHost) {
  if (item.id && titleHost) {
    // A text action reads better than another glyph beside the card title: it
    // follows the details popover in the heading and states its own outcome.
    const share = button('Copy link', () => void copyCardLink(item, share), 'card-link-copy');
    share.setAttribute('aria-label', `Copy a link to \u201c${item.title}\u201d`);
    share.title = 'Copy a shareable link to this card';
    titleHost.append(
      ' ',
      helpPopover(`Card ID: ${item.id}\nRevision: ${item.revision}`, 'Work item details'),
      ' ',
      share,
    );
  }
  if (item.id) fields.append(itemStatusSummary(item));
  const layout = el('div', undefined, 'item-editor-layout');
  const primary = el('div', undefined, 'item-editor-primary');
  const controls = el('div', undefined, 'item-editor-controls');
  layout.append(primary, controls);
  fields.append(layout);
  const title = field(primary, 'title', 'Title', draft?.title ?? item.title);
  title.required = true;
  title.maxLength = 240;
  title.setAttribute('aria-label', 'Title');
  const titleLabel = el('span', 'Title', 'item-title-label');
  title.parentElement.firstChild.replaceWith(titleLabel);
  if (context?.form && itemDateStatus(item)?.overdue) {
    const overdueBadge = dueDateBadge(item);
    if (overdueBadge) {
      overdueBadge.id = uid('item-title-overdue');
      title.setAttribute('aria-describedby', overdueBadge.id);
      appendEditorDueBadge(context.form, overdueBadge);
    }
  }
  markdownEditor(
    primary,
    'description',
    'Description',
    draft?.description ?? item.description,
    16000,
    readOnly,
    true,
  );
  const selfSubject = state.board.members.find(
    (member) => member.subject === state.session?.subject,
  )?.subject;
  const assigneePicker = multiSelect(
    controls,
    'assignee',
    'Assignee',
    [['', 'Unassigned'], ...state.board.members.map((m) => [m.subject, memberName(m.subject)])],
    [draft?.assignee ?? item.assignee],
    undefined,
    undefined,
    { single: true },
  );
  if (!readOnly && selfSubject) {
    const assignMe = button(
      'Assign me',
      () => assigneePicker.select(selfSubject),
      'multi-select-edit',
    );
    assignMe.setAttribute('aria-label', 'Assign me');
    assigneePicker.header.querySelector('.multi-select-heading').append(assignMe);
  }
  multiSelect(
    controls,
    'labels',
    'Labels',
    state.board.labels.map((label) => [label.name, label.name]),
    draft?.labels ?? item.labels,
    (chip, value) => {
      const label = labelInfo(value);
      chip.style.backgroundColor = label.color;
      chip.style.color = labelForeground(label.color);
      chip.classList.add('label-badge');
    },
    'Use Edit to add labels and × to remove them. Manage available labels from the Labels view.',
  );
  const selectedProjects = draft?.project_ids ?? itemProjectIDs(item);
  multiSelect(
    controls,
    'project_id',
    'Project',
    [['', 'No project'], ...state.board.projects.map((p) => [p.id, p.name])],
    selectedProjects.length ? selectedProjects : [''],
    undefined,
    'Choose one or more projects to classify this work item. Leave No project selected to keep it unclassified.',
    { emptyValue: '' },
  );
  itemDatesField(controls, item, draft);
  multiSelect(
    controls,
    'sprint_ids',
    'Open sprints',
    state.board.sprints
      .filter((s) => s.state !== 'closed')
      .map((s) => [s.id, `${s.name} (${s.state})`]),
    draft?.sprint_ids ?? item.sprint_ids,
    undefined,
    'Select no open sprint to keep unfinished work in the backlog. One item may span several sprints without creating duplicate cards.',
  );
  const closed = state.board.closed_scope
    .filter((s) => s.item_id === item.id)
    .map(
      (scope) => state.board.sprints.find((s) => s.id === scope.sprint_id)?.name || scope.sprint_id,
    );
  if (closed.length)
    controls.append(helpText('Closed sprint history (read-only): ' + closed.join(', ')));
  multiSelect(
    controls,
    'dependencies',
    'Depends on',
    state.board.items.filter((i) => i.id !== item.id).map((i) => [i.id, i.title]),
    draft?.dependencies ?? item.dependencies,
  );
  if (item.id) {
    const itemLinks = state.board.links.filter((link) => link.items.includes(item.id));
    const linkPicker = multiSelect(
      controls,
      'link_ids',
      'GitLab links',
      state.board.links.map((link) => [link.id, linkDisplayName(link)]),
      draft?.link_ids ?? itemLinks.map((link) => link.id),
      undefined,
      'Select registered merge requests to associate with this card. Paste a new MR URL below or use Add link when it is not listed.',
    );
    if (!readOnly) inlineGitLabPaste(linkPicker.group, item, readOnly, context);
    const linkActions = el('div', undefined, 'actions');
    if (!readOnly) {
      const add = writeButton('Add link', () => addGitLabLink(item, context));
      add.dataset.gitlabWrite = 'true';
      add.disabled = !gitLabWritable();
      linkActions.append(add);
    } else if (itemLinks.length)
      linkActions.append(
        button('View observations', () => {
          if (context.mode === 'modal') $('editor').close();
          showLinks(item);
        }),
      );
    if (linkActions.childElementCount) controls.append(linkActions);
  }
  controls.append(el('hr', undefined, 'item-editor-divider'));
  field(
    controls,
    'column_id',
    'Move to',
    draft?.column_id ?? item.column_id,
    'text',
    state.board.columns.map((c) => [c.id, c.name]),
  );
  if (item.id && !item.archived && !readOnly) {
    const archive = writeButton('Archive item', () => archiveItem(item, context), 'danger');
    archive.dataset.itemFooter = 'true';
    archive.dataset.write = 'true';
    archive.classList.add('archive-footer');
    const footer = context.footer || context.form.querySelector('.dialog-foot');
    const cancel = footer?.querySelector('#cancel,.detail-cancel');
    if (footer) footer.insertBefore(archive, cancel || footer.lastElementChild);
  }
  if (item.id && item.archived && state.board.role !== 'viewer') {
    const restore = writeButton('Restore item', () => void restoreSharedItem(item, context));
    restore.dataset.itemFooter = 'true';
    restore.dataset.write = 'true';
    const footer = context.footer || context.form.querySelector('.dialog-foot');
    const cancel = footer?.querySelector('#cancel,.detail-cancel');
    if (footer) footer.insertBefore(restore, cancel || footer.lastElementChild);
  }
  if (item.id) {
    renderItemAttachments(primary, item, readOnly);
    renderItemComments(primary, item);
  }
}
function createDetailPane() {
  const pane = el('aside', undefined, 'item-detail-pane');
  pane.hidden = true;
  pane.setAttribute('aria-label', 'Selected work item');
  state.detailPane = pane;
  return pane;
}
function syncListSelection() {
  document.querySelectorAll('.list-row').forEach((row) => {
    const selected = row.dataset.item === state.selectedItemID;
    row.classList.toggle('is-selected', selected);
    if (selected) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  });
}
function updateDetailPaneVisibility() {
  if (!state.detailPane) return;
  const open =
    !!state.detailState &&
    state.detailState.pane === state.detailPane &&
    !!state.selectedItemID &&
    state.detailState.form?.isConnected;
  state.detailPane.hidden = !open;
  state.detailPane.parentElement?.classList.toggle('has-detail', open);
  syncListSelection();
}
function detailDraftIsDirty(state) {
  if (!state?.form?.isConnected) return false;
  let current;
  try {
    current = itemEditorDraft(state.form);
  } catch {
    return true;
  }
  return (
    JSON.stringify(current) !== JSON.stringify(state.initialDraft) ||
    [...state.form.querySelectorAll('[data-comment-control]')].some((input) =>
      String(input.value || '').trim(),
    )
  );
}
function detailDiscardAllowed() {
  return (
    !state.detailState?.dirty ||
    window.confirm(`Discard unsaved changes to “${state.detailState.item?.title || 'this item'}”?`)
  );
}
function closeDetail({ force = false, focus = true } = {}) {
  if (state.busy) return false;
  if (!state.detailState) {
    state.selectedItemID = '';
    state.detailPane?.removeAttribute('data-item');
    updateDetailPaneVisibility();
    return true;
  }
  if (!force && !detailDiscardAllowed()) return false;
  const detail = state.detailState;
  state.detailState = undefined;
  state.selectedItemID = '';
  setSharedItem('');
  if (detail.pane) {
    detail.pane.hidden = true;
    detail.pane.replaceChildren();
    detail.pane.parentElement?.classList.remove('has-detail');
  }
  syncListSelection();
  if (focus) {
    const target = detail.origin?.isConnected
      ? detail.origin
      : [...document.querySelectorAll('.list-row')].find(
          (row) => row.dataset.item === detail.itemID,
        );
    if (target) target.focus({ preventScroll: true });
  }
  return true;
}
function selectItem(itemID, origin) {
  if (!state.board || state.view !== 'board' || state.presentation !== 'list') return false;
  if (state.detailState?.itemID === itemID) {
    if (origin) state.detailState.origin = origin;
    state.detailState.form?.querySelector('[name="title"]')?.focus({ preventScroll: true });
    return true;
  }
  if (!closeDetail({ focus: false })) return false;
  const item = state.board.items.find((value) => value.id === itemID);
  if (!item) return false;
  state.selectedItemID = itemID;
  openItemDetail(item, undefined, origin);
  return true;
}
function updateDetailHeader(item) {
  if (!state.detailState?.form || !item) return;
  state.detailState.item = item;
  const title = state.detailState.form.querySelector('.item-detail-title');
  if (title?.firstChild) title.firstChild.nodeValue = item.title;
  const help = title?.querySelector('.help-popover-content');
  if (help) help.textContent = `Card ID: ${item.id}\nRevision: ${item.revision}`;
}
function openItemDetail(item, draft, origin) {
  if (!state.detailPane) return;
  const readOnly = state.board.role === 'viewer' || item.archived;
  const form = el('form', undefined, 'item-detail-form');
  const heading = el('div', undefined, 'item-detail-head');
  const title = el('h2', item.title, 'item-detail-title');
  const actions = el('div', undefined, 'item-detail-head-actions');
  const close = button('×', () => closeDetail(), 'item-detail-close');
  close.setAttribute('aria-label', 'Close item details');
  actions.append(close);
  heading.append(title, actions);
  const fields = el('div', undefined, 'item-detail-fields');
  const error = errorLine('', 'item-detail-error');
  const footer = el('div', undefined, 'item-detail-footer');
  const cancel = button('Cancel', () => closeDetail(), 'detail-cancel');
  const save = button('Save changes', undefined, 'primary');
  save.type = 'submit';
  save.dataset.write = 'true';
  footer.append(cancel, save);
  form.append(heading, fields, error, footer);
  state.detailPane.replaceChildren(form);
  state.detailPane.hidden = false;
  const context = { mode: 'detail', form, footer, origin };
  buildItemEditor(fields, item, draft, readOnly, context, title);
  if (readOnly) {
    fields
      .querySelectorAll(
        'input:not([data-comment-control]),textarea:not([data-comment-control]),select:not([data-comment-control])',
      )
      .forEach((input) => {
        input.disabled = true;
      });
    fields.querySelectorAll('[data-multi-edit],[data-multi-remove]').forEach((input) => {
      input.disabled = true;
    });
  }
  save.hidden = readOnly;
  let revision = state.board.workspace.revision;
  let pending, key;
  state.detailState = {
    itemID: item.id,
    item,
    itemRevision: item.revision,
    form,
    pane: state.detailPane,
    origin,
    dirty: false,
    initialDraft: null,
  };
  const detail = state.detailState;
  setSharedItem(item.id);
  const updateDirty = () => {
    if (state.detailState === detail) detail.dirty = detailDraftIsDirty(detail);
  };
  form.addEventListener('input', updateDirty);
  form.addEventListener('change', updateDirty);
  detail.initialDraft = itemEditorDraft(form);
  updateDetailPaneVisibility();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (readOnly || state.busy || state.detailState !== detail) return;
    setErrorText(error, '');
    save.disabled = true;
    cancel.disabled = true;
    close.disabled = true;
    revision = state.board.workspace.revision;
    const data = new FormData(form);
    const desired = data.getAll('link_ids');
    detail.desiredLinkIDs = desired;
    const command = {
      revision,
      kind: 'item.update',
      target: item.id,
      item: { ...itemPayloadFromForm(data, detail.item), revision: detail.itemRevision },
    };
    const serialized = JSON.stringify(command);
    if (pending !== serialized) {
      key = requestKey();
      pending = serialized;
    }
    try {
      const result = await change(command, key);
      if (!result.refreshed)
        throw new Error(
          'Changes were saved, but the board could not be refreshed. Refresh before continuing.',
        );
      revision = receiptRevision(result.receipt, revision + 1);
      await reconcileItemLinks(item.id, detail.desiredLinkIDs || []);
      if (state.detailState !== detail || !state.board) return;
      const latest = state.board.items.find((value) => value.id === item.id);
      if (!latest) {
        closeDetail({ force: true });
        return;
      }
      detail.item = latest;
      detail.itemRevision = latest.revision;
      revision = state.board.workspace.revision;
      detail.initialDraft = itemEditorDraft(form);
      detail.dirty = false;
      updateDetailHeader(latest);
      refreshItemStatusSummary(form, latest);
      refreshEditorDueBadge(form, latest);
      notice('Changes saved.');
    } catch (err) {
      if (state.detailState === detail) {
        detail.dirty = true;
        setErrorText(
          error,
          `${err.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`,
        );
      }
    } finally {
      if (state.detailState === detail && form.isConnected) {
        save.disabled = false;
        cancel.disabled = false;
        close.disabled = false;
        renderControls();
      }
    }
  });
  const titleInput = form.querySelector('[name="title"]');
  if (titleInput) titleInput.focus({ preventScroll: true });
}
function reopenItemEditor(item, draft, mode, origin) {
  if (mode === 'detail') openItemDetail(item, draft, origin);
  else editItemModal(item, draft);
}
function editItemModal(item, draft) {
  const existing = !!item;
  const readOnly = state.board.role === 'viewer' || item?.archived;
  let desiredLinkIDs;
  const project = singleFilterValue('project');
  const projectIDs = ['all', 'none'].includes(project) ? [] : [project];
  item ||= {
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
  const context = { mode: 'modal', form: $('editor-form') };
  state.editorItemID = existing ? item.id : '';
  if (existing) setSharedItem(item.id);
  openEditor(
    existing ? 'Work item' : 'Create work item',
    (fields) => {
      context.form = $('editor-form');
      buildItemEditor(fields, item, draft, readOnly, context, $('editor-title'));
    },
    (data) => {
      if (existing) desiredLinkIDs = data.getAll('link_ids');
      return {
        kind: existing ? 'item.update' : 'item.create',
        target: item.id || '',
        item: itemPayloadFromForm(data, item),
      };
    },
    readOnly,
    existing ? () => reconcileItemLinks(item.id, desiredLinkIDs || []) : undefined,
  );
}
function editItem(item, draft) {
  if (item && state.view === 'board' && state.presentation === 'list') return selectItem(item.id);
  return editItemModal(item, draft);
}
function archiveItem(item, context) {
  if (context?.mode === 'modal') closeEditor();
  openEditor(
    'Archive work item',
    (fields) => {
      fields.append(
        el(
          'p',
          `Archive “${item.title}” and remove it from all open sprints? History is retained and the item can be restored. Unsaved editor changes will not be applied.`,
        ),
      );
      field(fields, 'reason', 'Archive rationale (optional)', '', 'textarea').maxLength = 4000;
    },
    (data) => ({ kind: 'item.archive', target: item.id, reason: data.get('reason') }),
    false,
    () => {
      offerUndo(`Archived “${item.title}” · undo is available for ${UNDO_TTL / 1000} seconds`, {
        kind: 'item.restore',
        target: item.id,
        restore_sprint_ids: [...(item.sprint_ids || [])],
      });
      if (context?.mode === 'detail') closeDetail({ force: true, focus: true });
    },
  );
  $('save').textContent = 'Archive item';
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
function editColumn(column) {
  $('editor').close();
  const existing = !!column;
  column ||= { name: '', category: 'todo', wip: 0 };
  openEditor(
    existing ? 'Edit board column' : 'Add board column',
    (fields) => {
      const name = field(fields, 'name', 'Column name', column.name);
      name.required = true;
      name.maxLength = 80;
      field(fields, 'category', 'Lifecycle category', column.category, 'text', [
        ['todo', 'To do'],
        ['doing', 'In progress'],
        ['done', 'Done'],
      ]);
      const wip = field(
        fields,
        'wip',
        'WIP limit · 0 means unlimited',
        String(column.wip),
        'number',
      );
      wip.min = 0;
      wip.max = 1000;
      wip.required = true;
      fields.append(
        helpText(
          'WIP counts all non-archived cards in this column, across sprints and backlog. A limit cannot be lowered below current occupancy.',
        ),
      );
    },
    (data) => ({
      kind: 'column.save',
      target: column.id || '',
      column: {
        ...column,
        name: data.get('name').trim(),
        category: data.get('category'),
        wip: Number(data.get('wip')),
      },
    }),
  );
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
function setupBoard() {
  openEditor(
    'Board setup',
    (fields) => {
      fields.append(
        helpText(
          'Configure columns, lifecycle categories, ordering, and WIP policy. All changes are revision checked.',
        ),
      );
      state.board.columns.forEach((c, index) => {
        const row = el('div', undefined, 'setup-row');
        row.append(
          el('strong', c.name),
          el('small', `${c.category} · WIP ${c.wip || 'unlimited'}`, 'muted'),
        );
        const actions = el('div', undefined, 'actions');
        actions.append(writeButton('Edit', () => editColumn(c)));
        if (index > 0)
          actions.append(
            writeButton('Move left', async () => {
              await quick({
                kind: 'column.rank',
                target: c.id,
                before: state.board.columns[index - 1].id,
              });
              $('editor').close();
            }),
          );
        if (state.board.columns.length > 1)
          actions.append(
            writeButton('Remove…', () => {
              $('editor').close();
              openEditor(
                'Remove column & move cards',
                (f) => {
                  f.append(
                    el(
                      'p',
                      `All cards in ${c.name}, including archived ones, must move to another column.`,
                    ),
                  );
                  field(
                    f,
                    'destination',
                    'Destination column',
                    '',
                    'text',
                    state.board.columns.filter((v) => v.id !== c.id).map((v) => [v.id, v.name]),
                  );
                },
                (data) => ({
                  kind: 'column.delete',
                  target: c.id,
                  destination: data.get('destination'),
                }),
              );
            }),
          );
        row.append(actions);
        fields.append(row);
      });
      fields.append(writeButton('＋ Add column', () => editColumn(), 'primary'));
    },
    () => ({}),
    true,
  );
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
