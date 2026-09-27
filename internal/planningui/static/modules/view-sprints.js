// Sprint panels, the Sprints page, sprint history and sprint dialogs.
import { markdownTemplate, markdownEditorTemplate } from './markdown.js';
import {
  fieldTemplate,
  sectionHeadTemplate,
  panelHeadTemplate,
  helpTextTemplate,
  emptyStateTemplate,
  metricListTemplate,
  maintenanceListTemplate,
} from './layout.js';
import { classNames } from './dom.js';
import { html, shallowEqual } from './vdom.js';
import { useId, useLayoutEffect, useRef, useState } from './vendor-preact.js';

import { setState, state, useStore } from './state.js';
import {
  actionIconTemplate,
  writeIconTemplate,
  accessButtonTemplate,
  usePermissions,
} from './permissions.js';
import { done, blocked, scopeItems } from './items.js';
import { boardLookups, itemLookup, selectLookups } from './lookups.js';
import { sprintFilterItems, sprintResults } from './filters.js';
import { PlanningFilters } from './planning-filters.js';
import { burndownTemplate } from './view-burndown.js';
import { quick } from './commands.js';
import { openDialog } from './dialog-state.js';
import { CommandDialog } from './dialog.js';
import { loadSprintHistory } from './page-data.js';
import { isAbortError } from './api.js';
import { toggleBurndown, viewSprintScope } from './actions.js';
import { sprintVelocityTemplate } from './view-velocity.js';

// The sprint goal measures its rendered height to decide whether to offer
// "Show more". Until the first measurement the goal stays inert.
function SprintGoal({ value }) {
  const contentID = `sprint-goal-${useId()}`;
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
function SprintActions({ sprint: s, expanded }) {
  const { busy } = usePermissions();
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
      aria-controls=${expanded ? `burndown-${s.id}` : null}
      disabled=${busy}
      onClick=${() => toggleBurndown(s.id)}
    ></button>
    ${actionIconTemplate('View scope', '◎', () => viewSprintScope(s))}
    ${s.state !== 'closed' ? writeIconTemplate('Edit sprint', '✎', () => openDialog('sprint.edit', { sprint: s })) : null}
    ${
      s.state === 'planned'
        ? writeIconTemplate(
            'Start sprint',
            '▶',
            () => quick({ kind: 'sprint.start', target: s.id }),
            'primary',
          )
        : null
    }
    ${s.state === 'active' ? writeIconTemplate('Close sprint', '■', () => closeSprint(s)) : null}
    ${
      s.state === 'closed'
        ? html`${writeIconTemplate('Re-open sprint', '↶', () =>
            quick({ kind: 'sprint.reopen', target: s.id }),
          )}${writeIconTemplate('Archive sprint', '▣', () => openDialog('sprint.archive', { sprint: s }), 'quiet')}`
        : null
    }
  </div>`;
}

function selectItemLookup(current) {
  return itemLookup(current.board, current.archiveItems);
}
// A changed goal gets a fresh goal widget; otherwise it keeps its measurement.
function SprintPanel({ sprint: s, items }) {
  const expanded = useStore((current) => current.burndownExpanded.includes(s.id));
  const lookups = useStore(selectLookups);
  const byID = useStore(selectItemLookup);
  return html`<article class="panel sprint-panel" data-sprint-id=${s.id}>
    <div class="sprint-info">
      <div class="sprint-title-row">
        <div class="sprint-title-copy">
          <p class="eyebrow">${`${s.state.toUpperCase()} SPRINT`}</p>
          <h2>${s.name}</h2>
        </div>
      </div>
      <${SprintGoal} key=${s.goal} value=${s.goal} />
      <small class="muted">${`${s.start} → ${s.end}`}</small>
      ${
        s.state === 'closed'
          ? html`<small class="muted"
              >Scope is preserved at closure. Archive this immutable sprint to keep it in paginated history; card details remain current.</small
            >`
          : null
      }
    </div>
    <${SprintActions} sprint=${s} expanded=${expanded} />
    ${metricListTemplate([
      [items.length, 'In scope'],
      [items.filter((i) => done(lookups, i)).length, s.state === 'closed' ? 'Done now' : 'Done'],
      [items.filter((i) => blocked(lookups, byID, i)).length, 'Blocked'],
    ])}
    ${expanded ? burndownTemplate(s) : null}
  </article>`;
}
function sprintRowsTemplate(page, { filtered, matches }) {
  const { board, filters } = page;
  const search = page.searchInput.trim();
  const query = page.searchQuery;
  if (!matches.length) {
    const message = !board.sprints.length
      ? 'No sprints yet. Create a goal and time box, then add work from the backlog.'
      : query && filtered.length !== board.sprints.length
        ? `No sprints match “${search}” and the current filters.`
        : query
          ? `No sprints match “${search}”.`
          : 'No sprints hold work matching the current filters.';
    return emptyStateTemplate(message);
  }
  return matches.map(
    (sprint) => html`<${SprintPanel}
      key=${sprint.id}
      sprint=${sprint}
      items=${sprintFilterItems(board, sprint, filters)}
    />`,
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
  } catch (error) {
    if (!isAbortError(error)) setState({ sprintHistoryError: error.message });
  }
}
function SprintHistoryRow({ record }) {
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
function sprintHistoryBody(page) {
  if (page.sprintHistoryError) return emptyStateTemplate(page.sprintHistoryError);
  if (!page.sprintHistory.length)
    return emptyStateTemplate(
      'No archived sprints yet. Close and archive a sprint to preserve its closure summary.',
    );
  return maintenanceListTemplate(
    'sprint-history-list',
    page.sprintHistory.map(
      (record) => html`<${SprintHistoryRow} key=${record.sprint?.id} record=${record} />`,
    ),
  );
}
function sprintHistoryTemplate(page) {
  return html`<section class="panel sprint-history">
    ${panelHeadTemplate('Archived sprint history', {
      description:
        'Immutable snapshots captured when each sprint closed. Archived sprints are read-only and do not consume the planning limit.',
    })}
    ${sprintHistoryBody(page)}
    ${
      !page.sprintHistoryError && page.sprintHistoryMore
        ? html`<button
            type="button"
            data-sprint-history-more="true"
            disabled=${page.busy || page.loading}
            onClick=${loadOlderSprintHistory}
          >Load older archived sprints</button>`
        : null
    }
  </section>`;
}
// Sprints uses the same page layout as Projects: a read-only summary section
// first, then a titled section whose shared planning filters sit below its heading.
const SPRINT_PAGE_KEYS = [
  'board',
  'session',
  'filters',
  'searchQuery',
  'searchInput',
  'busy',
  'loading',
  'sprintHistory',
  'sprintHistoryMore',
  'sprintHistoryError',
];
function selectSprintPage(current) {
  return Object.fromEntries(SPRINT_PAGE_KEYS.map((key) => [key, current[key]]));
}
// The page lists the sprints matching the planning filters and search; the
// shared filter bar renders in its slot below the section heading.
export function SprintsPage() {
  const page = useStore(selectSprintPage, shallowEqual);
  const { board, searchQuery, filters } = page;
  const lookups = boardLookups(board, page.session);
  const results = sprintResults(board, searchQuery, filters);
  return html`${sprintVelocityTemplate(board, lookups, filters)}
      <section class="sprint-planning">
        ${sectionHeadTemplate(
          'Goals, scope, and deliberate carry-over',
          accessButtonTemplate('＋ New sprint', () => openDialog('sprint.edit', {}), {
            className: 'primary',
            tracked: false,
          }),
        )}
        <div class="filter-slot" id="sprint-filter-slot"><${PlanningFilters} /></div>
        <div class="sprints" data-content-view="sprint-page-list">${sprintRowsTemplate(page, results)}</div>
      </section>
      ${sprintHistoryTemplate(page)}`;
}
function selectSummaryFilters(current) {
  return current.filters;
}
export function SprintSummary({ board, view, scope }) {
  useStore(selectSummaryFilters);
  const selected = board?.sprints?.find((sprint) => sprint.id === scope);
  const sprints =
    view !== 'board' || !board
      ? []
      : selected?.state === 'closed'
        ? [selected]
        : (board.sprints || []).filter((sprint) => sprint.state === 'active');
  const label = selected?.state === 'closed' ? `Closed sprint: ${selected.name}` : 'Active sprints';
  const content =
    view !== 'board' || !board
      ? null
      : html`${sprints.map(
          (sprint) =>
            html`<${SprintPanel} key=${sprint.id} sprint=${sprint} items=${scopeItems(board, sprint)} />`,
        )}${
          sprints.length
            ? null
            : emptyStateTemplate(
                'No active sprint. Use Sprint planning to create and start one, or keep a continuous Kanban flow.',
              )
        }`;
  return html`<section id="sprint-summary" class="sprints" aria-label=${label}>${content}</section>`;
}
/** @param {Flux.DialogProps['sprint.edit']} props */
export function SprintDialog({ sprint }) {
  const existing = !!sprint;
  /** @type {Partial<Flux.Sprint>} */
  const value = sprint || {
    name: '',
    goal: '',
    start: new Date().toISOString().slice(0, 10),
    end: new Date(Date.now() + 13 * 86400000).toISOString().slice(0, 10),
  };
  return html`<${CommandDialog}
    title=${existing ? 'Edit sprint' : 'Plan a sprint'}
    command=${(data) => {
      const goal = String(data.get('goal') || '').trim();
      if (!goal) throw new Error('Sprint goal is required.');
      return {
        kind: 'sprint.save',
        target: value.id || '',
        sprint: {
          ...value,
          name: data.get('name').trim(),
          goal,
          start: data.get('start'),
          end: data.get('end'),
        },
      };
    }}
  >
    ${fieldTemplate('name', 'Sprint name', value.name, 'text', undefined, {
      required: true,
      maxLength: 120,
    })}
    ${markdownEditorTemplate(
      'goal',
      'Sprint goal · what outcome matters?',
      value.goal,
      4000,
      false,
      false,
      { subject: 'sprint goal' },
    )}
    <div class="form-grid">
      ${fieldTemplate('start', 'Start date', value.start, 'date', undefined, { required: true })}
      ${fieldTemplate('end', 'End date', value.end, 'date', undefined, { required: true })}
    </div>
    ${helpTextTemplate(
      'Add or remove scope by editing an item’s sprint membership. Sprints belong to the workspace and can span projects. Multiple sprints can be active.',
    )}
  </${CommandDialog}>`;
}
function closeSprint(sprint) {
  const items = scopeItems(state.board, sprint);
  const lookups = selectLookups(state);
  openDialog('sprint.close', {
    sprint,
    scoped: items.length,
    unfinished: items.filter((i) => !done(lookups, i)).length,
    destinations: state.board.sprints
      .filter((s) => (s.state === 'planned' || s.state === 'active') && s.id !== sprint.id)
      .map((s) => [s.id, s.name]),
  });
}
/** @param {Flux.DialogProps['sprint.close']} props */
export function CloseSprintDialog({ sprint, scoped, unfinished, destinations }) {
  return html`<${CommandDialog}
    title="Close sprint & decide carry-over"
    saveText="Close sprint"
    command=${(data) => ({
      kind: 'sprint.close',
      target: sprint.id,
      destination: data.get('destination'),
      reason: data.get('reason').trim(),
    })}
  >
    <p>${`${sprint.name}: ${scoped} items in scope; ${unfinished} unfinished. Closing freezes this sprint’s scope. Other sprint assignments remain unchanged; the card keeps its identity and column.`}</p>
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
    })}
  </${CommandDialog}>`;
}
/** @param {Flux.DialogProps['sprint.archive']} props */
export function ArchiveSprintDialog({ sprint }) {
  return html`<${CommandDialog}
    title="Archive sprint"
    saveText="Archive sprint"
    command=${() => ({ kind: 'sprint.archive', target: sprint.id })}
  >
    <p>${`Archive “${sprint.name}”? The sprint will become immutable and leave the working sprint list. Its closure summary and metadata remain available in history.`}</p>
    ${helpTextTemplate(
      'Archiving does not delete cards or change their current columns. A closed sprint cannot be reopened after it is archived.',
    )}
  </${CommandDialog}>`;
}
