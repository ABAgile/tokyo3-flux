// Sprint panels, the Sprints page, sprint history and sprint dialogs.
import { $, el, button, field, uid } from './dom.js';
import { api } from './api.js';
import { renderMarkdown, markdownEditor } from './markdown.js';
import {
  pageStack,
  panel,
  sectionHead,
  panelHead,
  helpText,
  emptyState,
  metricList,
  filterSlot,
  maintenanceList,
  maintenanceRow,
} from './layout.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { actionIconButton, writeIconButton, writeButton } from './permissions.js';
import { done, blocked, scopeItems } from './items.js';
import { patchNode, keyedNodeKey, reconcileKeyedChildren } from './reconcile.js';
import { pageRoot } from './mount.js';
import { placeFilters, sprintFilterItems, sprintMatchesFilters } from './filters.js';
import { currentBurndownKey, renderBurndown } from './view-burndown.js';
import { quick } from './commands.js';
import { openEditor } from './dialog.js';
import { persistPlanningURL } from './url-state.js';
import { sprintVelocityPanel } from './view-velocity.js';

const sprintGoalLayouts = new Map();
const sprintGoalResizeObserver = new ResizeObserver(() => {
  for (const [content, update] of sprintGoalLayouts) {
    if (!content.isConnected) {
      sprintGoalLayouts.delete(content);
      sprintGoalResizeObserver.unobserve(content);
    } else update();
  }
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
      hooks.render();
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
      hooks.render();
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
        hooks.render();
      } catch (error) {
        state.sprintHistoryError = error.message;
        hooks.render();
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
// Sprints uses the same page layout as Projects: a read-only summary section
// first, then a titled section whose filter bar sits directly below its heading.
export function renderSprintPage(content) {
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
export function renderSprintSummary(sprints) {
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
const SPRINT_HISTORY_PAGE = 50;
export function resetSprintHistory() {
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
export async function loadSprintHistory(reset = false) {
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
