// Planning filters, work search and the filter chips.
import { labelForeground } from './format.js';
import { html } from './vdom.js';
import { setState, state, useStore } from './state.js';
import { projectName, itemProjectIDs, labelInfo, done, scopeItems } from './items.js';
import { memberName } from './people.js';
import { selectLookups } from './lookups.js';

// The Projects bar uses the same multi-value filter rules as the planning bar.
export const PROJECT_FILTER_NAMES = Object.freeze(['assignee', 'label']);
// Planning filters hold the accepted values of each name in the store. An empty
// list means "all", and the exclusive `none` value means "records with no
// association at all". The toolbar selects add one value at a time; chips below
// the toolbar are the authoritative, removable view of what is active.
export const FILTER_NAMES = Object.freeze(['project', 'assignee', 'label']);
export const SEARCH_DEBOUNCE_MS = 150;
// Each item's searchable text is memoized per board generation and revision.
const searchIndex = new WeakMap();

// Pure filter-value rules shared by every filter group. `none` is exclusive and
// can never be combined with concrete values.
export function withFilterValue(values, value) {
  if (!value || value === 'all') return [];
  if (value === 'none') return ['none'];
  const next = values.filter((current) => current !== 'none' && current !== String(value));
  return [...next, String(value)];
}
function withoutFilterValue(values, value) {
  return values.filter((current) => current !== String(value));
}
export function matchesFilter(values, candidates) {
  if (!values.length) return true;
  if (values.includes('none')) return candidates.length === 0;
  return candidates.some((value) => values.includes(value));
}
function emptyFilterGroup(group) {
  return Object.fromEntries(Object.keys(group).map((name) => [name, []]));
}

export function addPlanningFilter(name, value) {
  setState((current) => ({
    filters: { ...current.filters, [name]: withFilterValue(current.filters[name], value) },
  }));
}
// Unknown values are dropped whenever a board is loaded, so a renamed or
// removed project, member or label never leaves a filter nothing can match.
export function knownFilters(filters, board) {
  const next = Object.fromEntries(
    Object.entries(filters).map(([name, values]) => [
      name,
      values.filter((value) => knownFilterValue(name, value, board)),
    ]),
  );
  return Object.keys(next).every((name) => next[name].length === filters[name].length)
    ? filters
    : next;
}
// A single concrete selection still drives the project lens and the server-side
// burn-down filter, which accept one value. Wider selections fall back to all.
export function singleFilterValue(name, filters) {
  const values = filters[name];
  return values.length === 1 && values[0] !== 'none'
    ? values[0]
    : values.length === 1
      ? 'none'
      : 'all';
}
function filterOptionText(lookups, name, value) {
  if (value === 'none')
    return { project: 'No project', assignee: 'Unassigned', label: 'No labels' }[name];
  if (name === 'project') return projectName(lookups, value);
  if (name === 'assignee') return memberName(lookups, value);
  return value;
}
// Chips are the removable, authoritative view of any filter group. `onChange`
// receives the next group; `lookups` resolves the chip names.
export function FilterChips({
  group,
  names,
  lookups,
  onChange,
  disabled,
  clearLabel = 'Clear filters',
}) {
  const chips = [];
  names.forEach((name) => {
    group[name].forEach((value) => {
      const text = filterOptionText(lookups, name, value);
      const title = { project: 'Project', assignee: 'Assignee', label: 'Label' }[name];
      const color = name === 'label' && value !== 'none' ? labelInfo(lookups, value).color : '';
      const colors = color ? { 'background-color': color, color: labelForeground(color) } : {};
      chips.push(html`<span key=${`${name}:${value}`} class=${`filter-chip filter-chip-${name}`} style=${colors}>
        <span class="filter-chip-text">${`${title}: ${text}`}</span>
        <button
          type="button"
          class="filter-chip-remove"
          aria-label=${`Remove ${name} filter ${text}`}
          disabled=${disabled}
          onClick=${() => onChange({ ...group, [name]: withoutFilterValue(group[name], value) })}
        >×</button>
      </span>`);
    });
  });
  if (chips.length > 1)
    chips.push(html`<button
      key="clear"
      type="button"
      class="filter-chip-clear"
      disabled=${disabled}
      onClick=${() => onChange(emptyFilterGroup(group))}
    >${clearLabel}</button>`);
  return chips;
}
function filterSummaryText(lookups, name, filters) {
  const values = filters[name];
  if (!values.length)
    return { project: 'All projects', assignee: 'All assignees', label: 'All labels' }[name];
  return values.map((value) => filterOptionText(lookups, name, value)).join(', ');
}
export function knownFilterValue(name, value, board) {
  if (value === 'none') return true;
  if (name === 'project') return board.projects.some((project) => project.id === value);
  if (name === 'assignee') return board.members.some((member) => member.subject === value);
  return board.labels.some((label) => label.name === value);
}
// Searchable text is derived once per item revision. `boardGeneration` is
// bumped whenever the board is replaced, so renamed projects or members
// invalidate the memo without tracking each name individually.
function itemHaystack(lookups, item, generation) {
  const cached = searchIndex.get(item);
  if (cached && cached.generation === generation && cached.revision === item.revision)
    return cached.text;
  const projects = itemProjectIDs(item).map((id) => projectName(lookups, id));
  const text =
    `${item.title} ${item.description} ${item.labels.join(' ')} ${item.assignee} ${memberName(lookups, item.assignee)} ${projects.join(' ')}`.toLowerCase();
  searchIndex.set(item, { generation, revision: item.revision, text });
  return text;
}
export function normalizedSearch(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}
// Commits the search field's text and the query it filters by. The field owns
// its text while typing and commits once per pause, or at once for Enter and
// blur, so keystrokes never reach the store.
/** @param {string} text */
export function commitSearch(text) {
  const searchInput = String(text);
  setState({ searchInput, searchQuery: normalizedSearch(searchInput) });
}
function matchesItemFilters(item, filters) {
  return (
    matchesFilter(filters.project, itemProjectIDs(item)) &&
    matchesFilter(filters.assignee, item.assignee ? [item.assignee] : []) &&
    matchesFilter(filters.label, item.labels)
  );
}
// Work shown by a planning view (`board` or `archive`), derived from the store.
function computeFilteredItems(current, view) {
  const { board, searchQuery: query, scope, filters, boardGeneration } = current;
  const lookups = selectLookups(current);
  const sprint = lookups.sprintsById.get(scope);
  const active = view === 'archive' ? [] : lookups.activeSprints;
  const scoped =
    sprint && view !== 'archive'
      ? new Set(scopeItems(board, sprint).map((value) => value.id))
      : null;
  return (view === 'archive' ? current.archiveItems : board.items).filter((i) => {
    if (view === 'archive') {
      if (!i.archived) return false;
    } else if (i.archived && sprint?.state !== 'closed') return false;
    if (view !== 'archive') {
      if (scope === 'active' && !active.some((s) => i.sprint_ids.includes(s.id))) return false;
      if (scope === 'backlog' && (i.sprint_ids.length || done(lookups, i))) return false;
      if (scoped && !scoped.has(i.id)) return false;
    }
    if (!matchesItemFilters(i, filters)) return false;
    return !query || itemHaystack(lookups, i, boardGeneration).includes(query);
  });
}
const filteredCache = { board: undefined, archive: undefined };
// Memoized per view on every input it reads, so subscribers compare by identity.
export function selectFilteredItems(current, view = current.view) {
  if (!current.board || !['board', 'archive'].includes(view)) return EMPTY;
  const inputs = [
    current.board,
    current.archiveItems,
    current.searchQuery,
    current.scope,
    current.filters,
    current.boardGeneration,
  ];
  const cached = filteredCache[view];
  if (cached?.inputs.every((value, index) => Object.is(value, inputs[index]))) return cached.items;
  const items = computeFilteredItems(current, view);
  filteredCache[view] = { inputs, items };
  return items;
}
/** @type {readonly never[]} */
const EMPTY = Object.freeze([]);
export function filteredItems() {
  return selectFilteredItems(state);
}
export function PlanningFilterChips({ show, includeLabels, disabled }) {
  const filters = useStore(selectFilters);
  const lookups = useStore(selectLookups);
  const names = FILTER_NAMES.filter((name) => includeLabels || name !== 'label');
  const chips = show
    ? FilterChips({
        group: filters,
        names,
        lookups,
        disabled,
        onChange: (next) => setState({ filters: next }),
      })
    : [];
  return html`<div id="filter-chips" class="filter-chips" role="group" aria-label="Active filters" hidden=${!chips.length}>
    ${chips}
  </div>`;
}
function selectFilters(current) {
  return current.filters;
}
export function selectedFilterText(lookups, name, filters) {
  const values = filters[name];
  return values.length > 1
    ? `${filterSummaryText(lookups, name, filters)} (chart shows all)`
    : filterSummaryText(lookups, name, filters);
}
export function sprintFilterItems(board, sprint, filters) {
  return scopeItems(board, sprint).filter(
    (item) =>
      matchesFilter(filters.project, itemProjectIDs(item)) &&
      matchesFilter(filters.assignee, item.assignee ? [item.assignee] : []),
  );
}
// Project and assignee filters select which sprints are listed, not only what
// their metrics count: a sprint is shown when its scope still holds work that
// matches every active filter. Sprints are never filtered out while no work
// filter is active, so an empty sprint stays visible and plannable.
export function sprintMatchesFilters(board, sprint, filters) {
  if (!filters.project.length && !filters.assignee.length) return true;
  return sprintFilterItems(board, sprint, filters).length > 0;
}
// The sprints the Sprints page lists: those matching the work filters, then
// the search query against name and goal.
export function sprintResults(board, query, filters) {
  const filtered = (board?.sprints || []).filter((sprint) =>
    sprintMatchesFilters(board, sprint, filters),
  );
  const matches = filtered.filter(
    (sprint) => !query || `${sprint.name || ''} ${sprint.goal || ''}`.toLowerCase().includes(query),
  );
  return { filtered, matches };
}
