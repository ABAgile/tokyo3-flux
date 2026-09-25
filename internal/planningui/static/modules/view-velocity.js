// The delivery-trend (velocity) panel on the Sprints page.
import { el, svgNode } from './dom.js';
import { panel, panelHead, emptyState, metricList } from './layout.js';
import { state } from './state.js';
import { done } from './items.js';
import { sprintFilterItems, sprintMatchesFilters } from './filters.js';

// Delivery trend is derived from preserved closed-sprint scope and the current
// state of those cards. It is a live read of native planning records, not a
// recorded historical metric, so it is labeled as such.
const VELOCITY_SPRINTS = 8;
function velocitySeries() {
  return state.board.sprints
    .filter((sprint) => sprint.state === 'closed' && sprintMatchesFilters(sprint))
    .map((sprint) => {
      const items = sprintFilterItems(sprint);
      return { sprint, committed: items.length, completed: items.filter(done).length };
    })
    .slice(-VELOCITY_SPRINTS);
}
function velocityChart(series) {
  const width = 760,
    height = 200,
    left = 44,
    right = 16,
    top = 16,
    bottom = 40;
  const plotWidth = width - left - right,
    plotHeight = height - top - bottom;
  const maximum = Math.max(1, ...series.flatMap((entry) => [entry.committed, entry.completed]));
  const band = plotWidth / series.length,
    barWidth = Math.max(4, Math.min(28, band / 3));
  const y = (value) => top + ((maximum - value) / maximum) * plotHeight;
  const svg = svgNode('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': 'Committed and completed work per closed sprint',
    class: 'velocity-svg',
  });
  const title = svgNode('title');
  title.textContent = 'Committed and completed work per closed sprint';
  svg.append(title);
  [
    ...new Set(Array.from({ length: 4 }, (_, index) => Math.round(maximum * (1 - index / 3)))),
  ].forEach((value) => {
    svg.append(
      svgNode('line', {
        class: 'velocity-grid',
        x1: left,
        x2: width - right,
        y1: y(value),
        y2: y(value),
      }),
    );
    const label = svgNode('text', {
      class: 'velocity-axis-label',
      x: left - 8,
      y: y(value) + 4,
      'text-anchor': 'end',
    });
    label.textContent = String(value);
    svg.append(label);
  });
  series.forEach((entry, index) => {
    const center = left + band * (index + 0.5);
    [
      ['committed', entry.committed, center - barWidth - 2],
      ['completed', entry.completed, center + 2],
    ].forEach(([kind, value, x]) => {
      const bar = svgNode('rect', {
        class: `velocity-bar velocity-bar-${kind}`,
        x,
        y: y(value),
        width: barWidth,
        height: Math.max(1, y(0) - y(value)),
      });
      const label = svgNode('title');
      label.textContent = `${entry.sprint.name} · ${value} ${kind}`;
      bar.append(label);
      svg.append(bar);
    });
    const label = svgNode('text', {
      class: 'velocity-axis-label',
      x: center,
      y: height - 14,
      'text-anchor': 'middle',
    });
    label.textContent =
      entry.sprint.name.length > 14 ? `${entry.sprint.name.slice(0, 13)}…` : entry.sprint.name;
    svg.append(label);
  });
  return svg;
}
function velocityTable(series) {
  const details = el('details', undefined, 'velocity-data');
  details.dataset.stateKey = 'velocity-data';
  details.append(el('summary', 'View sprint values'));
  const scroll = el('div', undefined, 'velocity-table-scroll');
  const table = el('table');
  table.append(el('caption', 'Closed-sprint scope and current completion'));
  const head = el('thead');
  const heading = el('tr');
  ['Sprint', 'Committed', 'Completed'].forEach((text) => {
    const cell = el('th', text);
    cell.scope = 'col';
    heading.append(cell);
  });
  head.append(heading);
  table.append(head);
  const body = el('tbody');
  series.forEach((entry) => {
    const row = el('tr');
    const name = el('th', entry.sprint.name);
    name.scope = 'row';
    row.append(name, el('td', String(entry.committed)), el('td', String(entry.completed)));
    body.append(row);
  });
  table.append(body);
  scroll.append(table);
  details.append(scroll);
  return details;
}
export function sprintVelocityPanel() {
  const series = velocitySeries();
  const trend = panel('velocity-panel');
  trend.setAttribute('aria-labelledby', 'velocity-heading');
  trend.append(
    panelHead('Delivery trend', {
      id: 'velocity-heading',
      description: `Committed and completed work for the last ${VELOCITY_SPRINTS} closed sprints. Completion reflects each card's current column, not its state at closure.`,
    }),
  );
  if (!series.length) {
    const narrowed = state.board.sprints.some((sprint) => sprint.state === 'closed');
    trend.append(
      emptyState(
        narrowed
          ? 'No closed sprint holds work matching the current filters.'
          : 'No closed sprint yet. Close a sprint to start a delivery trend.',
      ),
    );
    trend.dataset.renderSignature = `velocity:empty:${narrowed}`;
    return trend;
  }
  const completed = series.map((entry) => entry.completed);
  const average = completed.reduce((sum, value) => sum + value, 0) / completed.length;
  const metrics = metricList(
    [
      [series.at(-1).completed, 'Last sprint'],
      [Math.round(average * 10) / 10, 'Average completed'],
      [Math.max(...completed), 'Best sprint'],
    ],
    'velocity-metrics',
  );
  const figure = el('figure', undefined, 'velocity-figure');
  figure.append(velocityChart(series));
  const legend = el('div', undefined, 'velocity-legend');
  [
    ['committed', 'Committed'],
    ['completed', 'Completed'],
  ].forEach(([kind, text]) => {
    const entry = el('span', undefined, 'velocity-legend-item');
    entry.append(
      el('span', undefined, `velocity-swatch velocity-swatch-${kind}`),
      el('span', text),
    );
    legend.append(entry);
  });
  figure.append(legend);
  trend.append(metrics, figure, velocityTable(series));
  trend.dataset.renderSignature = JSON.stringify(
    series.map((entry) => [entry.sprint.id, entry.sprint.name, entry.committed, entry.completed]),
  );
  return trend;
}
