// The shared planning filter bar: scope, add-a-filter selects, search, the
// Board/List toggle, the visible count and the removable filter chips.
import { html, shallowEqual } from './vdom.js';
import { Fragment, useEffect, useReducer } from './vendor-preact.js';
import { setState, state, useStore } from './state.js';
import { memberName } from './people.js';
import { labelOptionColors } from './items.js';
import {
  PlanningFilterChips,
  SEARCH_DEBOUNCE_MS,
  addPlanningFilter,
  flushSearch,
  normalizedSearch,
  selectFilteredItems,
  setSearchInput,
  sprintResults,
} from './filters.js';
import { setPresentation, setScope } from './actions.js';

// The one mounted search field, for the `/` shortcut: the planning frame and
// the Sprints page render the bar in turn, never both.
export const searchInputRef = { current: null };
function planningCount(current) {
  const { board, view } = current;
  if (!board) return '';
  if (view === 'sprints') {
    const count = sprintResults(board, current.searchQuery).matches.length;
    return `${count} ${count === 1 ? 'sprint' : 'sprints'}`;
  }
  if (!['board', 'archive'].includes(view)) return '';
  const items = selectFilteredItems(current, view);
  return view === 'archive'
    ? `${items.length} archived${current.archiveMore ? '+' : ''} · workspace revision ${board.workspace.revision}`
    : `${items.length} items · workspace revision ${board.workspace.revision}`;
}
function selectPlanningFilters(current) {
  return {
    board: current.board,
    view: current.view,
    presentation: current.presentation,
    scope: current.scope,
    filters: current.filters,
    searchInput: current.searchInput,
    busy: current.busy || current.loading,
    blocked: current.busy || current.loading || current.integrationFormOpen,
    count: planningCount(current),
  };
}
// Each select adds one value and returns to its "all" entry, so it reads as an
// add-a-filter control while the chip row owns the active state. A re-render
// after every choice puts the select back even when the value was already set.
export function PlanningFilters() {
  const bar = useStore(selectPlanningFilters, shallowEqual);
  const [, rerender] = useReducer((value) => value + 1, 0);
  const { board, view, presentation, scope, busy, blocked } = bar;
  const showFilters = !!board && !['history', 'projects', 'labels', 'members'].includes(view);
  const showLabelFilter = !['sprints', 'history'].includes(view);
  const addFilter = (name) => (event) => {
    addPlanningFilter(name, event.currentTarget.value);
    rerender();
  };
  const searchKeyDown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    flushSearch();
  };
  return html`<${Fragment}>
    <div id="planning-filters" class="filter-bar" hidden=${!showFilters}>
      <div class="actions">
        <label id="scope-label" hidden=${view !== 'board'}>Scope<select id="scope" data-focus-key="filter:scope" value=${scope} onChange=${(event) => setScope(event.currentTarget.value)}>
          <option value="active">Active sprints</option><option value="backlog">Backlog</option><option value="all">All open work</option>
          ${board?.sprints?.map((sprint) => html`<option key=${sprint.id} value=${sprint.id}>${`${sprint.name} (${sprint.state})`}</option>`)}
        </select></label>
        <label>Project<select id="project" data-focus-key="filter:project" aria-label="Project" value="all" disabled=${!board || busy} onChange=${addFilter('project')}>
          <option value="all">All projects</option><option value="none">No project</option>
          ${board?.projects?.map((project) => html`<option key=${project.id} value=${project.id}>${project.name}</option>`)}
        </select></label>
        <label>Assignee<select id="assignee" data-focus-key="filter:assignee" aria-label="Assignee" value="all" disabled=${!board || busy} onChange=${addFilter('assignee')}>
          <option value="all">All assignees</option><option value="none">Unassigned</option>
          ${board?.members?.map((member) => html`<option key=${member.subject} value=${member.subject}>${memberName(member.subject)}</option>`)}
        </select></label>
        <label id="label-filter" hidden=${!showLabelFilter}>Label<select id="label" data-focus-key="filter:label" aria-label="Label" value="all" disabled=${!board || busy} onChange=${addFilter('label')}>
          <option value="all">All labels</option><option value="none">No labels</option>
          ${board?.labels?.map((label) => html`<option key=${label.name} value=${label.name} style=${labelOptionColors(label.name)}>${label.name}</option>`)}
        </select></label>
        <label id="search-filter" hidden=${view === 'history'}>Search<input id="search" ref=${searchInputRef} data-focus-key="filter:search" type="search" autocomplete="off" value=${bar.searchInput} placeholder=${view === 'sprints' ? 'Find sprints…' : 'Find work…'} maxlength="240" onInput=${(event) => setSearchInput(event.currentTarget.value)} onChange=${flushSearch} onKeydown=${searchKeyDown} /></label>
      </div>
      <div class="filter-bar-end">
        <div id="presentation-toggle" class="presentation-toggle" role="group" aria-label="Planning presentation" hidden=${!board || view !== 'board'}>
          <button id="presentation-board" type="button" disabled=${!board || blocked} aria-pressed=${String(presentation === 'board')} onClick=${() => setPresentation('board')}>Board</button>
          <button id="presentation-list" type="button" disabled=${!board || blocked} aria-pressed=${String(presentation === 'list')} onClick=${() => setPresentation('list')}>List</button>
        </div>
        <span id="count" class="filter-bar-count muted">${bar.count}</span>
      </div>
    </div>
    <${PlanningFilterChips} show=${showFilters} includeLabels=${showLabelFilter} disabled=${busy} />
  </${Fragment}>`;
}
function selectSearchInput(current) {
  return current.searchInput;
}
// Typing filters once per pause: the committed query follows the input after
// a short quiet period, wherever the search field is rendered.
export function SearchDebounce() {
  const input = useStore(selectSearchInput);
  useEffect(() => {
    const timer = setTimeout(() => {
      const query = normalizedSearch(input);
      if (query !== state.searchQuery) setState({ searchQuery: query });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);
  return null;
}
