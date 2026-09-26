// Sprint panels, the Sprints page, sprint history and sprint dialogs.
import { $, uid } from './dom.js';
import { api } from './api.js';
import { markdownTemplate, markdownEditorTemplate } from './markdown.js';
import {
  renderPage,
  fieldTemplate,
  sectionHeadTemplate,
  panelHeadTemplate,
  helpTextTemplate,
  emptyStateTemplate,
  metricListTemplate,
  maintenanceListTemplate,
} from './layout.js';
import {
  classNames,
  html,
  withKey,
  nothing,
  render,
  keyedList,
  useLayoutEffect,
  useRef,
  useState,
} from './preact.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { actionIconTemplate, writeIconTemplate, accessButtonTemplate } from './permissions.js';
import { done, blocked, scopeItems } from './items.js';
import { placeFilters, sprintFilterItems, sprintMatchesFilters } from './filters.js';
import { burndownTemplate } from './view-burndown.js';
import { quick } from './commands.js';
import { openEditor } from './dialog.js';
import { persistPlanningURL } from './url-state.js';
import { sprintVelocityTemplate } from './view-velocity.js';

// The sprint goal measures its rendered height to decide whether to offer
// "Show more". Until the first measurement the goal stays inert.
function SprintGoal({ value }) {
  const [contentID] = useState(() => uid('sprint-goal'));
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState();
  const content = useRef();
  const measure = () => {
    const node = content.current;
    if (!node) return;
    const next = node.scrollHeight > node.clientHeight + 1;
    setClipped((previous) => (previous === next ? previous : next));
  };
  useLayoutEffect(() => {
    const observer = new ResizeObserver(measure);
    const frame = requestAnimationFrame(() => {
      if (!content.current?.isConnected) return;
      measure();
      observer.observe(content.current);
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  useLayoutEffect(() => measure(), [expanded, value]);
  const measured = clipped !== undefined;
  return html`<div class="sprint-goal">
    <div
      class=${classNames({ 'sprint-goal-content': true, 'is-expanded': expanded })}
      id=${contentID}
      inert=${!measured || (!expanded && clipped)}
      ref=${content}
    >${markdownTemplate(value)}</div
    ><button
      type="button"
      class="sprint-goal-toggle"
      hidden=${!measured || (!expanded && !clipped)}
      aria-controls=${contentID}
      aria-expanded=${String(expanded)}
      onClick=${() => setExpanded((previous) => !previous)}
    >${expanded ? 'Show less' : 'Show more'}</button>
  </div>`;
}
function sprintGoalTemplate(value) {
  return html`<${SprintGoal} value=${value} />`;
}
function toggleBurndown(s) {
  if (state.burndownExpanded.has(s.id)) state.burndownExpanded.delete(s.id);
  else state.burndownExpanded.add(s.id);
  hooks.render();
  [...document.querySelectorAll('[data-burndown-toggle]')]
    .find((element) => element.dataset.burndownToggle === s.id)
    ?.focus();
}
function viewSprintScope(s) {
  state.view = 'board';
  $('scope').value = s.id;
  hooks.render();
  persistPlanningURL();
}
function sprintActionsTemplate(s, expanded) {
  const label = expanded ? 'Hide burn down' : 'Show burn down';
  return html`<div class="actions sprint-actions">
    <button
      type="button"
      class="action-icon quiet"
      data-icon="▥"
      data-action-label=${label}
      aria-label=${label}
      title=${label}
      data-burndown-toggle=${s.id}
      aria-expanded=${String(expanded)}
      aria-controls=${expanded ? `burndown-${s.id}` : nothing}
      disabled=${state.busy || state.loading}
      onClick=${() => toggleBurndown(s)}
    ></button>
    ${actionIconTemplate('View scope', '◎', () => viewSprintScope(s))}
    ${s.state !== 'closed' ? writeIconTemplate('Edit sprint', '✎', () => editSprint(s)) : nothing}
    ${
      s.state === 'planned'
        ? writeIconTemplate(
            'Start sprint',
            '▶',
            () => quick({ kind: 'sprint.start', target: s.id }),
            'primary',
          )
        : nothing
    }
    ${s.state === 'active' ? writeIconTemplate('Close sprint', '■', () => closeSprint(s)) : nothing}
    ${
      s.state === 'closed'
        ? html`${writeIconTemplate('Re-open sprint', '↶', () =>
            quick({ kind: 'sprint.reopen', target: s.id }),
          )}${writeIconTemplate('Archive sprint', '▣', () => archiveSprint(s), 'quiet')}`
        : nothing
    }
  </div>`;
}
function sprintPanelTemplate(s, items = scopeItems(s)) {
  const expanded = state.burndownExpanded.has(s.id);
  // withKey gives a changed goal a fresh widget; otherwise it keeps its state.
  const goal = withKey(s.goal, sprintGoalTemplate(s.goal));
  return html`<article class="panel sprint-panel" data-sprint-id=${s.id}>
    <div class="sprint-info">
      <div class="sprint-title-row">
        <div class="sprint-title-copy">
          <p class="eyebrow">${`${s.state.toUpperCase()} SPRINT`}</p>
          <h2>${s.name}</h2>
        </div>
      </div>
      ${goal}
      <small class="muted">${`${s.start} → ${s.end}`}</small>
      ${
        s.state === 'closed'
          ? html`<small class="muted"
              >Scope is preserved at closure. Archive this immutable sprint to keep it in paginated history; card details remain current.</small
            >`
          : nothing
      }
    </div>
    ${sprintActionsTemplate(s, expanded)}
    ${metricListTemplate([
      [items.length, 'In scope'],
      [items.filter(done).length, s.state === 'closed' ? 'Done now' : 'Done'],
      [items.filter(blocked).length, 'Blocked'],
    ])}
    ${expanded ? burndownTemplate(s) : nothing}
  </article>`;
}
function sprintRowsTemplate() {
  const search = $('search').value.trim();
  const query = state.searchQuery;
  const filtered = state.board.sprints.filter(sprintMatchesFilters);
  const matches = filtered.filter(
    (sprint) => !query || `${sprint.name || ''} ${sprint.goal || ''}`.toLowerCase().includes(query),
  );
  $('count').textContent = `${matches.length} ${matches.length === 1 ? 'sprint' : 'sprints'}`;
  if (!matches.length) {
    const message = !state.board.sprints.length
      ? 'No sprints yet. Create a goal and time box, then add work from the backlog.'
      : query && filtered.length !== state.board.sprints.length
        ? `No sprints match “${search}” and the current filters.`
        : query
          ? `No sprints match “${search}”.`
          : 'No sprints hold work matching the current filters.';
    return emptyStateTemplate(message);
  }
  return keyedList(
    matches,
    (sprint) => sprint.id,
    (sprint) => sprintPanelTemplate(sprint, sprintFilterItems(sprint)),
  );
}
function sprintHistoryTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unknown closure time'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
async function loadOlderSprintHistory() {
  try {
    await loadSprintHistory();
    hooks.render();
  } catch (error) {
    state.sprintHistoryError = error.message;
    hooks.render();
  }
}
function sprintHistoryRowTemplate(record) {
  const sprint = record.sprint || {};
  const closure = record.closure || {};
  const counts = `${closure.scope_count || 0} committed · ${closure.completed_count || 0} completed · ${closure.carry_over_count || 0} carried over`;
  return html`<div class="setup-row maintenance-row" data-sprint-history-id=${sprint.id || ''}>
    <div class="maintenance-row-info">
      <strong>${sprint.name || 'Unnamed sprint'}</strong>
      <span class="help">${counts}</span>
      <small class="muted">${`Closed ${sprintHistoryTime(closure.closed_at)}`}</small>
    </div>
  </div>`;
}
function sprintHistoryBody() {
  if (state.sprintHistoryError) return emptyStateTemplate(state.sprintHistoryError);
  if (!state.sprintHistory.length)
    return emptyStateTemplate(
      'No archived sprints yet. Close and archive a sprint to preserve its closure summary.',
    );
  return maintenanceListTemplate(
    'sprint-history-list',
    state.sprintHistory.map(sprintHistoryRowTemplate),
  );
}
function sprintHistoryTemplate() {
  return html`<section class="panel sprint-history">
    ${panelHeadTemplate('Archived sprint history', {
      description:
        'Immutable snapshots captured when each sprint closed. Archived sprints are read-only and do not consume the planning limit.',
    })}
    ${sprintHistoryBody()}
    ${
      !state.sprintHistoryError && state.sprintHistoryMore
        ? html`<button
            type="button"
            data-sprint-history-more="true"
            disabled=${state.busy || state.loading}
            onClick=${loadOlderSprintHistory}
          >Load older archived sprints</button>`
        : nothing
    }
  </section>`;
}
// Sprints uses the same page layout as Projects: a read-only summary section
// first, then a titled section whose filter bar sits directly below its heading.
// The filter slot has no bound children, because the shared planning filter
// bar is moved into it (placeFilters).
export function renderSprintPage(content) {
  renderPage(
    content,
    'sprint-page',
    html`${sprintVelocityTemplate()}
      <section class="sprint-planning">
        ${sectionHeadTemplate(
          'Goals, scope, and deliberate carry-over',
          accessButtonTemplate('＋ New sprint', () => editSprint(), {
            className: 'primary',
            tracked: false,
          }),
        )}
        <div class="filter-slot" id="sprint-filter-slot"></div>
        <div class="sprints" data-content-view="sprint-page-list">${sprintRowsTemplate()}</div>
      </section>
      ${sprintHistoryTemplate()}`,
  );
  placeFilters($('sprint-filter-slot'));
}
// #sprint-summary collapses with :empty, so this template has no whitespace
// between its parts.
export function renderSprintSummary(sprints) {
  const summary = $('sprint-summary');
  if (state.view !== 'board') {
    render(nothing, summary);
    return;
  }
  const empty = emptyStateTemplate(
    'No active sprint. Use Sprint planning to create and start one, or keep a continuous Kanban flow.',
  );
  render(
    html`${keyedList(
      sprints,
      (sprint) => sprint.id,
      (sprint) => sprintPanelTemplate(sprint),
    )}${sprints.length ? nothing : empty}`,
    summary,
  );
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
    () => html`${fieldTemplate('name', 'Sprint name', sprint.name, 'text', undefined, {
      required: true,
      maxLength: 120,
    })}
      ${markdownEditorTemplate(
        'goal',
        'Sprint goal · what outcome matters?',
        sprint.goal,
        4000,
        false,
        false,
        { subject: 'sprint goal' },
      )}
      <div class="form-grid">
        ${fieldTemplate('start', 'Start date', sprint.start, 'date', undefined, { required: true })}
        ${fieldTemplate('end', 'End date', sprint.end, 'date', undefined, { required: true })}
      </div>
      ${helpTextTemplate(
        'Add or remove scope by editing an item’s sprint membership. Sprints belong to the workspace and can span projects. Multiple sprints can be active.',
      )}`,
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
  const destinations = state.board.sprints
    .filter((s) => (s.state === 'planned' || s.state === 'active') && s.id !== sprint.id)
    .map((s) => [s.id, s.name]);
  openEditor(
    'Close sprint & decide carry-over',
    () => html`<p>${`${sprint.name}: ${items.length} items in scope; ${unfinished.length} unfinished. Closing freezes this sprint’s scope. Other sprint assignments remain unchanged; the card keeps its identity and column.`}</p>
      ${fieldTemplate('destination', 'Also assign unfinished work to', '', 'text', [
        ['', 'No additional sprint'],
        ...destinations,
      ])}
      ${helpTextTemplate(
        'No additional sprint returns an item to backlog only if it has no other open sprint membership. Existing memberships are never removed by closing another sprint.',
      )}
      ${fieldTemplate('reason', 'Closing decision / rationale', '', 'textarea', undefined, {
        required: true,
        maxLength: 4000,
      })}`,
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
    () => html`<p>${`Archive “${sprint.name}”? The sprint will become immutable and leave the working sprint list. Its closure summary and metadata remain available in history.`}</p>
      ${helpTextTemplate(
        'Archiving does not delete cards or change their current columns. A closed sprint cannot be reopened after it is archived.',
      )}`,
    () => ({ kind: 'sprint.archive', target: sprint.id }),
  );
  $('save').textContent = 'Archive sprint';
}
