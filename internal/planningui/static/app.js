import { $, button, options } from './modules/dom.js';
import { api, apiRevalidated } from './modules/api.js';
import { emptyState } from './modules/layout.js';
import { state } from './modules/state.js';
import { hooks } from './modules/hooks.js';
import { writable } from './modules/permissions.js';
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
import { initShortcuts } from './modules/shortcuts.js';
import {
  workspaceListSignature,
  loadWorkspaces,
  enterWorkspaceGate,
  refreshWorkspaceGate,
  renderWorkspaceSelection,
  renderWorkspaceCreation,
  firstRunChecklist,
  showFirstRun,
  showWorkspaceCreate,
  chooseWorkspace,
} from './modules/view-gate.js';
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
initShortcuts();
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
