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
import { html, shallowEqual } from './vdom.js';
import { useId, useLayoutEffect, useRef, useState, h } from './vendor-preact.js';
import { useEventListener, useHoverHint } from './ui-hooks.js';
import { placeMenu } from './card-menu.js';

import { setState, state, useStore, requireBoard } from './state.js';
import { actionIconTemplate, writeIconTemplate, accessButtonTemplate } from './permissions.js';
import { done, blocked, scopeItems } from './items.js';
import { boardLookups, itemLookup, selectLookups } from './lookups.js';
import { sprintFilterItems, sprintResults } from './filters.js';
import { PlanningFilters } from './planning-filters.js';
import { burndownTemplate } from './view-burndown.js';
import { quick } from './commands.js';
import { openDialog } from './dialog-state.js';
import { CommandDialog } from './dialog.js';
import { loadSprintHistory } from './page-data.js';
import { errorMessage, isAbortError } from './api.js';
import { toggleBurndown, viewSprintScope } from './actions.js';
import { sprintVelocityTemplate } from './view-velocity.js';

// The goal's rendered Markdown, with the note a closed sprint carries. It is a
// hint while the panel is folded and a block under the title once it is open.
/** @param {Flux.Sprint} s */
function sprintGoalTemplate(s) {
  return html`<div class="sprint-goal"><div class="sprint-goal-content">${markdownTemplate(s.goal)}</div></div>
    ${
      s.state === 'closed'
        ? html`<p class="muted sprint-goal-note"
            >Scope is preserved at closure. Archive this immutable sprint to keep it in paginated history; card details remain current.</p
          >`
        : null
    }`;
}
// The hint's box, fixed and placed against the viewport from the button that
// opened it.
/** @param {{ sprint: Flux.Sprint, id: string, anchor: { current: HTMLElement | null } }} props */
function SprintGoalPopover({ sprint: s, id, anchor }) {
  const node = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [at, setAt] = useState(
    /** @type {{ left: number, top: number } | undefined} */ (undefined),
  );
  useLayoutEffect(() => {
    if (!anchor.current || !node.current) return;
    const next = placeMenu({
      anchor: anchor.current.getBoundingClientRect(),
      size: node.current.getBoundingClientRect(),
      viewport: { width: innerWidth, height: innerHeight },
      beside: false,
      align: 'start',
    });
    setAt((current) => (current?.left === next.left && current.top === next.top ? current : next));
  });
  return html`<div
    class="sprint-goal-popover"
    id=${id}
    role="group"
    aria-label="Sprint goal"
    ref=${node}
    style=${at ? { left: `${at.left}px`, top: `${at.top}px` } : { left: '0px', top: '0px', opacity: '0' }}
  >${sprintGoalTemplate(s)}</div>`;
}
// While a sprint panel is folded its goal is an `i` hint beside the name, behaving
// as every hint does (hover or keyboard focus, click ignored). Its box stays open
// while the pointer is on it, so links in the goal work, and scrolling or
// resizing the page closes it, since the box is fixed.
/** @param {{ sprint: Flux.Sprint }} props */
function SprintGoalHint({ sprint: s }) {
  const popoverID = `sprint-goal-${useId()}`;
  const wrapper = useRef(/** @type {HTMLSpanElement | null} */ (null));
  const button = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const hint = useHoverHint(wrapper);
  // The box's own scrolling is not the page moving.
  useEventListener(window, 'resize', hint.close, { active: hint.open });
  useEventListener(
    document,
    'scroll',
    (event) => {
      const target = /** @type {Node | null} */ (event.target);
      if (!target || !wrapper.current?.contains(target)) hint.close();
    },
    { active: hint.open, capture: true },
  );
  return html`<span class="sprint-goal-hint-wrap" ref=${wrapper} ...${hint.wrapperProps}>
    <button
      type="button"
      class="help-trigger is-info sprint-goal-hint"
      aria-label=${`Goal of ${s.name}`}
      aria-expanded=${String(hint.open)}
      aria-controls=${hint.open ? popoverID : null}
      ref=${button}
      ...${hint.triggerProps}
    >i</button>
    ${hint.open ? html`<${SprintGoalPopover} sprint=${s} id=${popoverID} anchor=${button} />` : null}
  </span>`;
}
/** @param {{ sprint: Flux.Sprint }} props */
function SprintActions({ sprint: s }) {
  return html`<div class="actions sprint-actions">
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

/** @param {Flux.State} current */
function selectItemLookup(current) {
  return itemLookup(current.board, current.archiveItems);
}
// A sprint panel is a header: the sprint's kind and dates, its name with a goal
// hint, its counts and its actions. Clicking anywhere on it that is not a control
// expands it, or folds it back, so the board stays the focus until a sprint is
// asked for. Expanded, it states the sprint's goal under the title, in place of
// the hint, and shows its burn-down chart. The name is the button for keyboards.
/** @param {{ sprint: Flux.Sprint, items: readonly Flux.Item[] }} props */
function SprintPanel({ sprint: s, items }) {
  const expanded = useStore((current) => current.burndownExpanded.includes(s.id));
  const lookups = useStore(selectLookups);
  const byID = useStore(selectItemLookup);
  const toggleFromBox = (/** @type {MouseEvent} */ event) => {
    const target = /** @type {Element | null} */ (event.target);
    if (target?.closest?.('button,a,input,select,textarea,summary,details,label')) return;
    if (window.getSelection()?.toString()) return;
    toggleBurndown(s.id);
  };
  return html`<article class="panel sprint-panel" data-sprint-id=${s.id} onClick=${toggleFromBox}>
    <div class="sprint-head">
      <div class="sprint-info">
        <p class="sprint-kicker">
          <span class="eyebrow">${`${s.state.toUpperCase()} SPRINT`}</span>
          <small class="muted">${`${s.start} → ${s.end}`}</small>
        </p>
        <div class="sprint-title-row">
          <h2 class="sprint-title-copy">
            <button
              type="button"
              class="sprint-toggle"
              title=${expanded ? 'Hide burn down' : 'Show burn down'}
              aria-expanded=${String(expanded)}
              aria-controls=${expanded ? `burndown-${s.id}` : null}
              onClick=${() => toggleBurndown(s.id)}
            ><span class="sprint-chevron" aria-hidden="true"></span><span>${s.name}</span></button>
          </h2>
          ${expanded ? null : html`<${SprintGoalHint} sprint=${s} />`}
        </div>
      </div>
      <div class="sprint-side">
        ${metricListTemplate([
          [items.length, 'In scope'],
          [
            items.filter((i) => done(lookups, i)).length,
            s.state === 'closed' ? 'Done now' : 'Done',
          ],
          [items.filter((i) => blocked(lookups, byID, i)).length, 'Blocked'],
        ])}
        <${SprintActions} sprint=${s} />
      </div>
    </div>
    ${
      expanded
        ? html`<div class="sprint-goal-display">
            <span class="eyebrow">GOAL</span>${sprintGoalTemplate(s)}
          </div>`
        : null
    }
    ${expanded ? burndownTemplate(s) : null}
  </article>`;
}
/**
 * @param {SprintPageData} page
 * @param {{ filtered: Flux.Sprint[], matches: Flux.Sprint[] }} results
 */
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
/** @param {string} value */
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
    if (!isAbortError(error)) setState({ sprintHistoryError: errorMessage(error) });
  }
}
/** @param {{ record: Flux.SprintHistoryRecord }} props */
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
/** @param {SprintPageData} page */
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
/** @param {SprintPageData} page */
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
/** @type {readonly (keyof Flux.State)[]} */
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
/**
 * The page renders only while a workspace is open, so its board exists.
 * @typedef {Pick<Flux.State, 'session' | 'filters' | 'searchQuery' | 'searchInput' | 'busy'
 *   | 'loading' | 'sprintHistory' | 'sprintHistoryMore' | 'sprintHistoryError'>
 *   & { board: Flux.Board }} SprintPageData
 */
/** @param {Flux.State} current */
function selectSprintPage(current) {
  return /** @type {SprintPageData} */ (
    Object.fromEntries(SPRINT_PAGE_KEYS.map((key) => [key, current[key]]))
  );
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
/** @param {Flux.State} current */
function selectSummaryFilters(current) {
  return current.filters;
}
/** @param {{ board: Flux.Board | undefined, view: string, scope: string }} props */
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
  return h(
    CommandDialog,
    {
      title: existing ? 'Edit sprint' : 'Plan a sprint',
      command: (data) => {
        const goal = String(data.get('goal') || '').trim();
        if (!goal) throw new Error('Sprint goal is required.');
        return {
          kind: 'sprint.save',
          target: value.id || '',
          sprint: {
            ...value,
            name: String(data.get('name') || '').trim(),
            goal,
            start: String(data.get('start') || ''),
            end: String(data.get('end') || ''),
          },
        };
      },
    },
    html`
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
    `,
  );
}
/** @param {Flux.Sprint} sprint */
function closeSprint(sprint) {
  const items = scopeItems(requireBoard(), sprint);
  const lookups = selectLookups(state);
  openDialog('sprint.close', {
    sprint,
    scoped: items.length,
    unfinished: items.filter((i) => !done(lookups, i)).length,
    destinations: requireBoard()
      .sprints.filter((s) => (s.state === 'planned' || s.state === 'active') && s.id !== sprint.id)
      .map((s) => /** @type {[string, string]} */ ([s.id, s.name])),
  });
}
/** @param {Flux.DialogProps['sprint.close']} props */
export function CloseSprintDialog({ sprint, scoped, unfinished, destinations }) {
  return h(
    CommandDialog,
    {
      title: 'Close sprint & decide carry-over',
      saveText: 'Close sprint',
      command: (data) => ({
        kind: 'sprint.close',
        target: sprint.id,
        destination: String(data.get('destination') || ''),
        reason: String(data.get('reason') || '').trim(),
      }),
    },
    html`
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
    `,
  );
}
/** @param {Flux.DialogProps['sprint.archive']} props */
export function ArchiveSprintDialog({ sprint }) {
  return h(
    CommandDialog,
    {
      title: 'Archive sprint',
      saveText: 'Archive sprint',
      command: () => ({ kind: 'sprint.archive', target: sprint.id }),
    },
    html`
      <p>${`Archive “${sprint.name}”? The sprint will become immutable and leave the working sprint list. Its closure summary and metadata remain available in history.`}</p>
      ${helpTextTemplate(
        'Archiving does not delete cards or change their current columns. A closed sprint cannot be reopened after it is archived.',
      )}
    `,
  );
}
