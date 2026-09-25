// The sprint burn-down chart, its table and its requests.
import { el, button, svgNode } from './dom.js';
import { api } from './api.js';
import { burndownDateLabel } from './format.js';
import { panel, panelHead, helpText, errorLine, emptyState, metricList } from './layout.js';
import { state } from './state.js';
import { hooks } from './hooks.js';
import { setContentBusy } from './mount.js';
import { singleFilterValue, selectedFilterText } from './filters.js';

export function resetBurndown() {
  state.burndownGeneration++;
  state.burndownData.clear();
  state.burndownRequests.clear();
  state.burndownErrors.clear();
}
export function currentBurndownKey(sprintID) {
  return [
    state.board?.workspace.revision || 0,
    sprintID,
    singleFilterValue('project'),
    singleFilterValue('assignee'),
  ].join('|');
}
function burndownSegments(points, key, x, y) {
  const segments = [];
  let segment = [];
  const flush = () => {
    if (segment.length > 1) segments.push(segment.join(' '));
    segment = [];
  };
  points.forEach((point, index) => {
    if (!Number.isFinite(point[key])) {
      flush();
      return;
    }
    segment.push(`${x(index)},${y(point[key])}`);
  });
  flush();
  return segments;
}
function burndownSVG(data) {
  const width = 760,
    height = 220,
    left = 48,
    right = 20,
    top = 16,
    bottom = 36,
    plotWidth = width - left - right,
    plotHeight = height - top - bottom,
    points = data.points;
  const values = points.flatMap((point) => [point.scope, point.remaining]).filter(Number.isFinite);
  const maximum = Math.max(1, ...values);
  const x = (index) =>
    points.length > 1 ? left + (index / (points.length - 1)) * plotWidth : left + plotWidth / 2;
  const y = (value) => top + ((maximum - value) / maximum) * plotHeight;
  const svg = svgNode('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `Burn down for ${data.sprint.name}`,
    class: 'burndown-svg',
  });
  const title = svgNode('title');
  title.textContent = `Burn down for ${data.sprint.name}`;
  svg.append(title);
  [
    ...new Set(Array.from({ length: 5 }, (_, index) => Math.round(maximum * (1 - index / 4)))),
  ].forEach((value) => {
    const line = svgNode('line', {
      class: 'burndown-grid',
      x1: left,
      x2: width - right,
      y1: y(value),
      y2: y(value),
    });
    svg.append(line);
    const label = svgNode('text', {
      class: 'burndown-axis-label',
      x: left - 8,
      y: y(value) + 4,
      'text-anchor': 'end',
    });
    label.textContent = String(value);
    svg.append(label);
  });
  const first = points.findIndex((point) => Number.isFinite(point.remaining));
  if (first >= 0) {
    const idealStart = Number.isFinite(points[first].scope)
      ? points[first].scope
      : points[first].remaining;
    svg.append(
      svgNode('line', {
        class: 'burndown-ideal',
        x1: x(first),
        x2: x(points.length - 1),
        y1: y(idealStart),
        y2: y(0),
      }),
    );
  }
  burndownSegments(points, 'scope', x, y).forEach((segment) =>
    svg.append(svgNode('polyline', { class: 'burndown-scope', points: segment })),
  );
  burndownSegments(points, 'remaining', x, y).forEach((segment) =>
    svg.append(svgNode('polyline', { class: 'burndown-actual', points: segment })),
  );
  points.forEach((point, index) => {
    if (!Number.isFinite(point.remaining)) return;
    const circle = svgNode('circle', {
      class: 'burndown-point',
      cx: x(index),
      cy: y(point.remaining),
      r: 3,
    });
    const label = svgNode('title');
    label.textContent = `${burndownDateLabel(point.date)} · ${point.remaining} remaining · ${point.scope} in scope`;
    circle.append(label);
    svg.append(circle);
  });
  [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].forEach((index) => {
    if (index < 0 || !points[index]) return;
    const label = svgNode('text', {
      class: 'burndown-axis-label',
      x: x(index),
      y: height - 16,
      'text-anchor': index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle',
    });
    label.textContent = burndownDateLabel(points[index].date);
    svg.append(label);
  });
  return svg;
}
function burndownLegendItem(className, text) {
  const item = el('span', undefined, 'burndown-legend-item');
  item.append(el('span', undefined, `burndown-swatch ${className}`), el('span', text));
  return item;
}
function burndownTable(data) {
  const details = el('details', undefined, 'burndown-data');
  details.dataset.stateKey = `burndown-data:${data.sprint.id}`;
  details.append(el('summary', 'View daily values'));
  const scroll = el('div', undefined, 'burndown-table-scroll');
  const table = el('table');
  table.append(el('caption', 'Daily native work-item counts'));
  const head = el('thead');
  const heading = el('tr');
  const metric = el('th', 'Metric');
  metric.scope = 'col';
  heading.append(metric);
  data.points.forEach((point) => {
    const date = el('th', burndownDateLabel(point.date));
    date.scope = 'col';
    heading.append(date);
  });
  head.append(heading);
  table.append(head);
  const body = el('tbody');
  [
    ['In scope', 'scope'],
    ['Remaining', 'remaining'],
  ].forEach(([label, key]) => {
    const row = el('tr');
    const metric = el('th', label);
    metric.scope = 'row';
    row.append(metric);
    data.points.forEach((point) =>
      row.append(el('td', point[key] == null ? '—' : String(point[key]))),
    );
    body.append(row);
  });
  table.append(body);
  scroll.append(table);
  details.append(scroll);
  return details;
}
function latestBurndownPoint(points, key) {
  return [...points].reverse().find((point) => Number.isFinite(point[key]));
}
function firstBurndownPoint(points, key) {
  return points.find((point) => Number.isFinite(point[key]));
}
export function renderBurndown(sprint) {
  const chart = panel('burndown-panel');
  chart.id = `burndown-${sprint.id}`;
  const headingID = `burndown-heading-${sprint.id}`;
  chart.setAttribute('aria-labelledby', headingID);
  const filterCondition = el('div', undefined, 'burndown-filter-condition');
  filterCondition.append(
    el('p', `Project: ${selectedFilterText('project')}`, 'muted'),
    el('p', `Assignee: ${selectedFilterText('assignee')}`, 'muted'),
  );
  const context = el('div', undefined, 'burndown-context');
  context.append(
    panelHead('Remaining work', {
      id: headingID,
      description: filterCondition,
      className: 'burndown-head',
    }),
  );
  const key = currentBurndownKey(sprint.id);
  const data = state.burndownData.get(key);
  const error = state.burndownErrors.get(key);
  if (error) {
    const retry = button('Retry burn down', () => requestBurndown(sprint.id, true));
    retry.disabled = state.busy || state.loading;
    const message = errorLine(error);
    chart.append(context, message, retry);
    return chart;
  }
  if (!data) {
    chart.append(context, emptyState('Loading native planning history…'));
    requestBurndown(sprint.id);
    return chart;
  }
  if (!data.history_available) {
    chart.append(context, emptyState(data.warning));
    return chart;
  }
  const available = data.points.some((point) => Number.isFinite(point.remaining));
  if (!available) {
    chart.append(
      context,
      emptyState(data.warning || 'No matching work is available for this sprint and filter.'),
    );
    return chart;
  }
  const first = firstBurndownPoint(data.points, 'remaining');
  const latest = latestBurndownPoint(data.points, 'remaining');
  context.append(
    metricList(
      [
        [firstBurndownPoint(data.points, 'scope')?.scope ?? first.remaining, 'Starting scope'],
        [latest.remaining, 'Remaining'],
        [latest.scope, 'Ending scope'],
      ],
      'burndown-metrics',
    ),
  );
  const note = helpText(data.warning, 'burndown-note');
  context.append(note);
  const figure = el('figure', undefined, 'burndown-figure');
  figure.append(burndownSVG(data));
  const legend = el('div', undefined, 'burndown-legend');
  legend.append(
    burndownLegendItem('actual', 'Remaining'),
    burndownLegendItem('ideal', 'Ideal'),
    burndownLegendItem('scope', 'Scope'),
  );
  figure.append(legend);
  const row = el('div', undefined, 'burndown-chart-row');
  row.append(context, figure);
  chart.append(row, burndownTable(data));
  return chart;
}
async function requestBurndown(sprintID, force = false) {
  if (!state.board || !state.burndownExpanded.has(sprintID) || state.loading) return;
  const key = currentBurndownKey(sprintID);
  if (state.burndownRequests.has(key)) return;
  if (!force && (state.burndownData.has(key) || state.burndownErrors.has(key))) return;
  if (force) {
    state.burndownData.delete(key);
    state.burndownErrors.delete(key);
  }
  const generation = state.burndownGeneration;
  const currentBoard = state.board,
    currentRoot = state.root;
  const token = {};
  state.burndownRequests.set(key, token);
  setContentBusy(true);
  try {
    const query = new URLSearchParams({
      sprint: sprintID,
      project: singleFilterValue('project'),
      assignee: singleFilterValue('assignee'),
    });
    const next = await api(currentRoot + '/burndown?' + query);
    if (
      generation !== state.burndownGeneration ||
      state.board !== currentBoard ||
      state.root !== currentRoot
    )
      return;
    if (!next || !Array.isArray(next.points) || !next.sprint)
      throw new Error('Burn-down data is invalid. Refresh to retry.');
    if (next.revision !== currentBoard.workspace.revision)
      throw new Error('Planning changed while loading. Refresh to review.');
    state.burndownData.set(key, next);
    state.burndownErrors.delete(key);
  } catch (e) {
    if (
      generation !== state.burndownGeneration ||
      state.board !== currentBoard ||
      state.root !== currentRoot
    )
      return;
    state.burndownErrors.set(key, e.message);
  } finally {
    if (state.burndownRequests.get(key) === token) state.burndownRequests.delete(key);
    if (
      generation !== state.burndownGeneration ||
      state.board !== currentBoard ||
      state.root !== currentRoot
    )
      // biome-ignore lint/correctness/noUnsafeFinally: a stale response must not render; try/catch never rethrow.
      return;
    if (!state.burndownRequests.size) setContentBusy(false);
    if (state.view === 'board' || state.view === 'sprints') hooks.render();
  }
}
