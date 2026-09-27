// Read-only helpers over the board model: projects, labels, sprints, blockers.
// Every helper takes the data it reads; `lookups` comes from `boardLookups`.
import { labelForeground } from './format.js';
import { html } from './vdom.js';

/**
 * @param {Flux.Lookups} lookups
 * @param {string} id
 */
export function projectName(lookups, id) {
  return lookups.projectsById.get(id)?.name || 'No project';
}
/**
 * @param {Partial<Flux.Item> | undefined} item
 * @returns {string[]}
 */
export function itemProjectIDs(item) {
  if (Array.isArray(item?.project_ids)) return item.project_ids.filter(Boolean).map(String);
  return item?.project_id ? [String(item.project_id)] : [];
}
/**
 * @param {Flux.Lookups} lookups
 * @param {Flux.Item} item
 * @param {string} [className]
 */
export function projectBadgesTemplate(lookups, item, className = 'card-project') {
  const names = itemProjectIDs(item).map((id) => projectName(lookups, id));
  if (!names.length) names.push('No project');
  return names.map((name) => html`<span class="badge badge-project ${className}">${name}</span>`);
}
/**
 * @param {Flux.Lookups} lookups
 * @param {string} name
 * @returns {Flux.Label}
 */
export function labelInfo(lookups, name) {
  return lookups.labelsByName.get(name) || { name, color: '#dcefe4' };
}
// Preact applies style objects through CSSOM; style strings/attributes would
// violate the style-src policy.
/**
 * @param {Flux.Lookups} lookups
 * @param {string} name
 */
export function labelBadgeTemplate(lookups, name) {
  const label = labelInfo(lookups, name);
  const colors = { 'background-color': label.color, color: labelForeground(label.color) };
  return html`<span class="badge badge-label label-badge" data-label=${name} style=${colors}>${name}</span>`;
}
// A label option's colours, for renderOptions.
/**
 * @param {Flux.Lookups} lookups
 * @param {string} name
 */
export function labelOptionColors(lookups, name) {
  const label = labelInfo(lookups, name);
  return { 'background-color': label.color, color: labelForeground(label.color) };
}
/**
 * @param {Flux.Lookups} lookups
 * @param {Flux.Item} item
 */
export function done(lookups, item) {
  return lookups.columnsById.get(item.column_id)?.category === 'done';
}
// Dependency targets may be archived, so resolution spans the board payload and
// the loaded archive page. Event handlers and commands pass the current state.
/**
 * @param {string | undefined} id
 * @param {Readonly<Flux.State>} current
 * @returns {Flux.Item | undefined}
 */
export function findItem(id, current) {
  return (
    current.board?.items.find((value) => value.id === id) ||
    current.archiveItems.find((value) => value.id === id)
  );
}
// `items` is `itemLookup(board, archiveItems)`.
/**
 * @param {Flux.Lookups} lookups
 * @param {ReadonlyMap<string, Flux.Item>} items
 * @param {Flux.Item} item
 */
export function blocked(lookups, items, item) {
  return item.dependencies.some((id) => {
    const dep = items.get(id);
    return dep && !done(lookups, dep);
  });
}
/**
 * @param {Flux.Board} board
 * @param {Flux.Sprint} sprint
 * @returns {Flux.Item[]}
 */
export function scopeItems(board, sprint) {
  return sprint.state === 'closed'
    ? board.items.filter((i) =>
        board.closed_scope.some((s) => s.sprint_id === sprint.id && s.item_id === i.id),
      )
    : board.items.filter((i) => !i.archived && i.sprint_ids.includes(sprint.id));
}
