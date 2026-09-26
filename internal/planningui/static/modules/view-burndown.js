// The sprint burn-down chart, its table and its requests.
import { api } from './api.js';
import { burndownDateLabel } from './format.js';
import {
  panelHeadTemplate,
  helpTextTemplate,
  errorLineTemplate,
  emptyStateTemplate,
  metricListTemplate,
} from './layout.js';
import { html, nothing, svg } from './lit.js';
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
  const title = `Burn down for ${data.sprint.name}`;
  const grid = [
    ...new Set(Array.from({ length: 5 }, (_, index) => Math.round(maximum * (1 - index / 4)))),
  ].map(
    (value) =>
      svg`<line class="burndown-grid" x1=${left} x2=${width - right} y1=${y(value)} y2=${y(value)}></line><text class="burndown-axis-label" x=${left - 8} y=${y(value) + 4} text-anchor="end">${String(value)}</text>`,
  );
  const first = points.findIndex((point) => Number.isFinite(point.remaining));
  const idealStart =
    first >= 0
      ? Number.isFinite(points[first].scope)
        ? points[first].scope
        : points[first].remaining
      : 0;
  const ideal =
    first >= 0
      ? svg`<line class="burndown-ideal" x1=${x(first)} x2=${x(points.length - 1)} y1=${y(idealStart)} y2=${y(0)}></line>`
      : nothing;
  const lines = (key, className) =>
    burndownSegments(points, key, x, y).map(
      (segment) => svg`<polyline class=${className} points=${segment}></polyline>`,
    );
  const dots = points.map((point, index) =>
    Number.isFinite(point.remaining)
      ? svg`<circle class="burndown-point" cx=${x(index)} cy=${y(point.remaining)} r="3"><title>${`${burndownDateLabel(point.date)} · ${point.remaining} remaining · ${point.scope} in scope`}</title></circle>`
      : nothing,
  );
  const dates = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].map(
    (index) => {
      if (index < 0 || !points[index]) return nothing;
      const anchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
      return svg`<text class="burndown-axis-label" x=${x(index)} y=${height - 16} text-anchor=${anchor}>${burndownDateLabel(points[index].date)}</text>`;
    },
  );
  return html`<svg
    viewBox=${`0 0 ${width} ${height}`}
    role="img"
    aria-label=${title}
    class="burndown-svg"
  ><title>${title}</title>${grid}${ideal}${lines('scope', 'burndown-scope')}${lines('remaining', 'burndown-actual')}${dots}${dates}</svg>`;
}
function burndownLegendItem(className, text) {
  return html`<span class="burndown-legend-item"
    ><span class=${`burndown-swatch ${className}`}></span><span>${text}</span></span
  >`;
}
function burndownTable(data) {
  const rows = [
    ['In scope', 'scope'],
    ['Remaining', 'remaining'],
  ];
  // The <details> open state belongs to the user; the template never binds it.
  return html`<details class="burndown-data" data-state-key=${`burndown-data:${data.sprint.id}`}>
    <summary>View daily values</summary>
    <div class="burndown-table-scroll">
      <table>
        <caption>Daily native work-item counts</caption>
        <thead>
          <tr>
            <th scope="col">Metric</th>
            ${data.points.map((point) => html`<th scope="col">${burndownDateLabel(point.date)}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            ([label, key]) => html`<tr>
              <th scope="row">${label}</th>
              ${data.points.map(
                (point) => html`<td>${point[key] == null ? '—' : String(point[key])}</td>`,
              )}
            </tr>`,
          )}
        </tbody>
      </table>
    </div>
  </details>`;
}
function latestBurndownPoint(points, key) {
  return [...points].reverse().find((point) => Number.isFinite(point[key]));
}
function firstBurndownPoint(points, key) {
  return points.find((point) => Number.isFinite(point[key]));
}
function burndownBody(sprint, context) {
  const key = currentBurndownKey(sprint.id);
  const data = state.burndownData.get(key);
  const error = state.burndownErrors.get(key);
  if (error)
    return html`${context()}${errorLineTemplate(error)}<button
        type="button"
        ?disabled=${state.busy || state.loading}
        @click=${() => requestBurndown(sprint.id, true)}
      >Retry burn down</button>`;
  if (!data) {
    requestBurndown(sprint.id);
    return html`${context()}${emptyStateTemplate('Loading native planning history…')}`;
  }
  if (!data.history_available) return html`${context()}${emptyStateTemplate(data.warning)}`;
  if (!data.points.some((point) => Number.isFinite(point.remaining)))
    return html`${context()}${emptyStateTemplate(
      data.warning || 'No matching work is available for this sprint and filter.',
    )}`;
  const first = firstBurndownPoint(data.points, 'remaining');
  const latest = latestBurndownPoint(data.points, 'remaining');
  const metrics = metricListTemplate(
    [
      [firstBurndownPoint(data.points, 'scope')?.scope ?? first.remaining, 'Starting scope'],
      [latest.remaining, 'Remaining'],
      [latest.scope, 'Ending scope'],
    ],
    'burndown-metrics',
  );
  return html`<div class="burndown-chart-row">
      ${context(metrics, helpTextTemplate(data.warning, 'burndown-note'))}
      <figure class="burndown-figure">
        ${burndownSVG(data)}
        <div class="burndown-legend">
          ${burndownLegendItem('actual', 'Remaining')}${burndownLegendItem('ideal', 'Ideal')}${burndownLegendItem('scope', 'Scope')}
        </div>
      </figure>
    </div>
    ${burndownTable(data)}`;
}
export function burndownTemplate(sprint) {
  const headingID = `burndown-heading-${sprint.id}`;
  const filterCondition = html`<div class="burndown-filter-condition">
    <p class="muted">${`Project: ${selectedFilterText('project')}`}</p>
    <p class="muted">${`Assignee: ${selectedFilterText('assignee')}`}</p>
  </div>`;
  const context = (...extra) => html`<div class="burndown-context">
    ${panelHeadTemplate('Remaining work', {
      id: headingID,
      description: filterCondition,
      className: 'burndown-head',
    })}${extra}
  </div>`;
  return html`<section
    class="panel burndown-panel"
    id=${`burndown-${sprint.id}`}
    aria-labelledby=${headingID}
  >${burndownBody(sprint, context)}</section>`;
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
