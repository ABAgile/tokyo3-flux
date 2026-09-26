// Read-only helpers over the board model: projects, labels, sprints, blockers.
import { labelForeground } from './format.js';
import { html, nodeOf, nodesOf, styleProps } from './lit.js';
import { state } from './state.js';

export function activeSprints() {
  return state.board.sprints.filter((s) => s.state === 'active');
}
export function projectName(id) {
  return state.board.projects.find((p) => p.id === id)?.name || 'No project';
}
export function itemProjectIDs(item) {
  if (Array.isArray(item?.project_ids)) return item.project_ids.filter(Boolean).map(String);
  return item?.project_id ? [String(item.project_id)] : [];
}
export function projectBadgesTemplate(item, className = 'card-project') {
  const names = itemProjectIDs(item).map(projectName);
  if (!names.length) names.push('No project');
  return names.map((name) => html`<span class="badge badge-project ${className}">${name}</span>`);
}
export function projectBadges(item, className) {
  return nodesOf(html`${projectBadgesTemplate(item, className)}`);
}
export function labelInfo(name) {
  return state.board.labels.find((label) => label.name === name) || { name, color: '#dcefe4' };
}
// Label colours are user data, so they are set through the CSSOM (styleProps)
// rather than a style attribute, which the style-src policy would block.
export function labelBadgeTemplate(name) {
  const label = labelInfo(name);
  const colors = { 'background-color': label.color, color: labelForeground(label.color) };
  return html`<span class="badge badge-label label-badge" data-label=${name} ${styleProps(colors)}>${name}</span>`;
}
export function labelBadge(name) {
  return nodeOf(labelBadgeTemplate(name));
}
export function styleLabelOptions(select) {
  [...select.options].forEach((option) => {
    const label = labelInfo(option.value);
    option.style.backgroundColor = label.color;
    option.style.color = labelForeground(label.color);
  });
}
export function done(item) {
  return state.board.columns.find((c) => c.id === item.column_id)?.category === 'done';
}
// Dependency targets may be archived, so resolution spans the board payload and
// the loaded archive page.
export function findItem(id) {
  return (
    state.board?.items.find((value) => value.id === id) ||
    state.archiveItems.find((value) => value.id === id)
  );
}
export function blocked(item) {
  return item.dependencies.some((id) => {
    const dep = findItem(id);
    return dep && !done(dep);
  });
}
export function scopeItems(sprint) {
  return sprint.state === 'closed'
    ? state.board.items.filter((i) =>
        state.board.closed_scope.some((s) => s.sprint_id === sprint.id && s.item_id === i.id),
      )
    : state.board.items.filter((i) => !i.archived && i.sprint_ids.includes(sprint.id));
}
