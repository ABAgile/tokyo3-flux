// Planning filters, work search and the filter chips.
import { $, el, button } from './dom.js';
import { labelForeground } from './format.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import {
  activeSprints,
  projectName,
  itemProjectIDs,
  labelInfo,
  done,
  scopeItems,
} from './items.js';
import { memberName } from './people.js';
import { setContentBusy } from './mount.js';

// The Projects bar uses the same multi-value filter rules as the planning bar.
export const PROJECT_FILTER_NAMES = Object.freeze(['assignee', 'label']);
export const projectFilters = { assignee: new Set(), label: new Set() };
// Planning filters hold a set of accepted values each. An empty set means "all",
// and the exclusive `none` value means "records with no association at all".
// The toolbar selects add one value at a time; chips below the toolbar are the
// authoritative, removable view of what is active.
export const FILTER_NAMES = Object.freeze(['project', 'assignee', 'label']);
const filters = { project: new Set(), assignee: new Set(), label: new Set() };
// Search is debounced so a long board is filtered once per pause rather than
// once per keystroke, and each item's searchable text is memoized per revision.
const SEARCH_DEBOUNCE_MS = 150;
const searchIndex = new WeakMap();
// Filter state. An empty set accepts everything; `none` is exclusive and means
// "no association", so it can never be combined with concrete values. Every
// filter group — the planning bar and the Projects bar — shares these rules.
export function filterValues(name, group = filters) {
  return [...group[name]];
}
export function addFilterValue(name, value, group = filters) {
  const set = group[name];
  if (!value || value === 'all') {
    set.clear();
    return;
  }
  if (value === 'none') {
    set.clear();
    set.add('none');
    return;
  }
  set.delete('none');
  set.add(String(value));
}
function removeFilterValue(name, value, group = filters) {
  group[name].delete(String(value));
}
export function setFilterValues(name, values, group = filters) {
  group[name] = new Set();
  values.forEach((value) => addFilterValue(name, value, group));
}
export function clearFilterGroup(group) {
  Object.keys(group).forEach((name) => group[name].clear());
}
export function clearFilters() {
  clearFilterGroup(filters);
}
export function matchesFilter(name, values, group = filters) {
  const set = group[name];
  if (!set.size) return true;
  if (set.has('none')) return values.length === 0;
  return values.some((value) => set.has(value));
}
// A single concrete selection still drives the project lens and the server-side
// burn-down filter, which accept one value. Wider selections fall back to all.
export function singleFilterValue(name) {
  const values = filterValues(name);
  return values.length === 1 && values[0] !== 'none'
    ? values[0]
    : values.length === 1
      ? 'none'
      : 'all';
}
function filterOptionText(name, value) {
  if (value === 'none')
    return { project: 'No project', assignee: 'Unassigned', label: 'No labels' }[name];
  if (name === 'project') return projectName(value);
  if (name === 'assignee') return memberName(value);
  return value;
}
// Chips are the removable, authoritative view of any filter group.
export function filterChipNodes(group, names, onChange, { clearLabel = 'Clear filters' } = {}) {
  const chips = [];
  names.forEach((name) => {
    filterValues(name, group).forEach((value) => {
      const text = filterOptionText(name, value);
      const chip = el('span', undefined, `filter-chip filter-chip-${name}`);
      chip.append(
        el(
          'span',
          `${{ project: 'Project', assignee: 'Assignee', label: 'Label' }[name]}: ${text}`,
          'filter-chip-text',
        ),
      );
      if (name === 'label' && value !== 'none') {
        const color = labelInfo(value).color;
        chip.style.backgroundColor = color;
        chip.style.color = labelForeground(color);
      }
      const remove = button(
        '×',
        () => {
          removeFilterValue(name, value, group);
          onChange(name);
        },
        'filter-chip-remove',
      );
      remove.setAttribute('aria-label', `Remove ${name} filter ${text}`);
      remove.disabled = state.busy || state.loading;
      chip.append(remove);
      chips.push(chip);
    });
  });
  if (chips.length > 1) {
    const clear = button(
      clearLabel,
      () => {
        clearFilterGroup(group);
        onChange(names[0]);
      },
      'filter-chip-clear',
    );
    clear.disabled = state.busy || state.loading;
    chips.push(clear);
  }
  return chips;
}
function filterSummaryText(name) {
  const values = filterValues(name);
  if (!values.length)
    return { project: 'All projects', assignee: 'All assignees', label: 'All labels' }[name];
  return values.map((value) => filterOptionText(name, value)).join(', ');
}
export function knownFilterValue(name, value) {
  if (value === 'none') return true;
  if (name === 'project') return state.board.projects.some((project) => project.id === value);
  if (name === 'assignee') return state.board.members.some((member) => member.subject === value);
  return state.board.labels.some((label) => label.name === value);
}
// Searchable text is derived once per item revision. `searchIndexGeneration` is
// bumped whenever the board is replaced, so renamed projects or members
// invalidate the memo without tracking each name individually.
function itemHaystack(item) {
  const cached = searchIndex.get(item);
  if (
    cached &&
    cached.generation === state.searchIndexGeneration &&
    cached.revision === item.revision
  )
    return cached.text;
  const text =
    `${item.title} ${item.description} ${item.labels.join(' ')} ${item.assignee} ${memberName(item.assignee)} ${itemProjectIDs(item).map(projectName).join(' ')}`.toLowerCase();
  searchIndex.set(item, { generation: state.searchIndexGeneration, revision: item.revision, text });
  return text;
}
// Typing filters once per pause. `flushSearch` applies the pending query
// immediately for Enter, blur, and any programmatic reset.
export function resetSearch() {
  if (state.searchDebounce) clearTimeout(state.searchDebounce);
  state.searchDebounce = undefined;
  $('search').value = '';
  state.searchQuery = '';
}
export function flushSearch() {
  if (state.searchDebounce) clearTimeout(state.searchDebounce);
  state.searchDebounce = undefined;
  const next = $('search').value.trim().toLowerCase();
  if (next === state.searchQuery) return false;
  state.searchQuery = next;
  return true;
}
export function queueSearch() {
  if (state.searchDebounce) clearTimeout(state.searchDebounce);
  state.searchDebounce = setTimeout(() => {
    state.searchDebounce = undefined;
    if (flushSearch() && state.board) hooks.renderContent();
  }, SEARCH_DEBOUNCE_MS);
}
function matchesItemFilters(item) {
  return (
    matchesFilter('project', itemProjectIDs(item)) &&
    matchesFilter('assignee', item.assignee ? [item.assignee] : []) &&
    matchesFilter('label', item.labels)
  );
}
export function filteredItems() {
  const query = state.searchQuery;
  const scope = $('scope').value;
  const sprint = state.board.sprints.find((s) => s.id === scope);
  return (state.view === 'archive' ? state.archiveItems : state.board.items).filter((i) => {
    if (state.view === 'archive') {
      if (!i.archived) return false;
    } else if (i.archived && sprint?.state !== 'closed') return false;
    if (state.view !== 'archive') {
      if (scope === 'active' && !activeSprints().some((s) => i.sprint_ids.includes(s.id)))
        return false;
      if (scope === 'backlog' && (i.sprint_ids.length || done(i))) return false;
      if (sprint && !scopeItems(sprint).some((v) => v.id === i.id)) return false;
    }
    if (!matchesItemFilters(i)) return false;
    return !query || itemHaystack(i).includes(query);
  });
}
// The planning filter bar is one element that is relocated, not duplicated, so
// its controls keep their state, handlers and identity across views.
export function placeFilters(host = $('planning-filter-slot')) {
  const bar = $('planning-filters'),
    chips = $('filter-chips');
  if (bar.parentElement !== host) host.append(bar);
  if (chips.parentElement !== host || chips.previousElementSibling !== bar) host.append(chips);
}
export function renderFilterChips() {
  const host = $('filter-chips');
  const names = FILTER_NAMES.filter((name) => !(name === 'label' && $('label-filter').hidden));
  const chips = filterChipNodes(filters, names, applyFilterChange);
  host.hidden = !chips.length || $('planning-filters').hidden;
  host.replaceChildren(...chips);
}
// Project and assignee filters feed the burn-down request, so changing them
// invalidates any cached chart; label filtering is client-side only.
export function applyFilterChange(name) {
  if (name !== 'label') hooks.resetBurndown();
  hooks.render();
  if (name !== 'label' && !state.burndownRequests.size) setContentBusy(false);
  hooks.persistPlanningURL();
}
export function selectedFilterText(name) {
  const values = filterValues(name);
  return values.length > 1
    ? `${filterSummaryText(name)} (chart shows all)`
    : filterSummaryText(name);
}
export function sprintFilterItems(sprint) {
  return scopeItems(sprint).filter(
    (item) =>
      matchesFilter('project', itemProjectIDs(item)) &&
      matchesFilter('assignee', item.assignee ? [item.assignee] : []),
  );
}
// Project and assignee filters select which sprints are listed, not only what
// their metrics count: a sprint is shown when its scope still holds work that
// matches every active filter. Sprints are never filtered out while no work
// filter is active, so an empty sprint stays visible and plannable.
export function sprintMatchesFilters(sprint) {
  if (!filters.project.size && !filters.assignee.size) return true;
  return sprintFilterItems(sprint).length > 0;
}
