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
import { html } from './vdom.js';
import { useEffect } from './vendor-preact.js';
import { setState, state, subscribe, useStore } from './state.js';
import { singleFilterValue, selectedFilterText } from './filters.js';
import { selectLookups } from './lookups.js';
import { useRequest, waitUntil } from './ui-hooks.js';
import { usePermissions } from './permissions.js';

/** @param {number | null} value @returns {value is number} */
const isCount = (value) => Number.isFinite(value);
/**
 * @param {readonly Flux.BurndownPoint[]} points
 * @param {'scope' | 'remaining'} key
 * @param {(index: number) => number} x
 * @param {(value: number) => number} y
 */
function burndownSegments(points, key, x, y) {
  /** @type {string[]} */
  const segments = [];
  /** @type {string[]} */
  let segment = [];
  const flush = () => {
    if (segment.length > 1) segments.push(segment.join(' '));
    segment = [];
  };
  points.forEach((point, index) => {
    if (!isCount(point[key])) {
      flush();
      return;
    }
    segment.push(`${x(index)},${y(point[key])}`);
  });
  flush();
  return segments;
}
/** @param {Flux.Burndown} data */
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
  const values = points.flatMap((point) => [point.scope, point.remaining]).filter(isCount);
  const maximum = Math.max(1, ...values);
  const x = (/** @type {number} */ index) =>
    points.length > 1 ? left + (index / (points.length - 1)) * plotWidth : left + plotWidth / 2;
  const y = (/** @type {number} */ value) => top + ((maximum - value) / maximum) * plotHeight;
  const title = `Burn down for ${data.sprint.name}`;
  const grid = [
    ...new Set(Array.from({ length: 5 }, (_, index) => Math.round(maximum * (1 - index / 4)))),
  ].map(
    (value) =>
      html`<line class="burndown-grid" x1=${left} x2=${width - right} y1=${y(value)} y2=${y(value)}></line><text class="burndown-axis-label" x=${left - 8} y=${y(value) + 4} text-anchor="end">${String(value)}</text>`,
  );
  const first = points.findIndex((point) => Number.isFinite(point.remaining));
  const idealStart = /** @type {number} */ (
    first >= 0 ? (isCount(points[first].scope) ? points[first].scope : points[first].remaining) : 0
  );
  const ideal =
    first >= 0
      ? html`<line class="burndown-ideal" x1=${x(first)} x2=${x(points.length - 1)} y1=${y(idealStart)} y2=${y(0)}></line>`
      : null;
  const lines = (/** @type {'scope' | 'remaining'} */ key, /** @type {string} */ className) =>
    burndownSegments(points, key, x, y).map(
      (segment) => html`<polyline class=${className} points=${segment}></polyline>`,
    );
  const dots = points.map((point, index) =>
    isCount(point.remaining)
      ? html`<circle class="burndown-point" cx=${x(index)} cy=${y(point.remaining)} r="3"><title>${`${burndownDateLabel(point.date)} · ${point.remaining} remaining · ${point.scope} in scope`}</title></circle>`
      : null,
  );
  const dates = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].map(
    (index) => {
      if (index < 0 || !points[index]) return null;
      const anchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
      return html`<text class="burndown-axis-label" x=${x(index)} y=${height - 16} text-anchor=${anchor}>${burndownDateLabel(points[index].date)}</text>`;
    },
  );
  return html`<svg
    viewBox=${`0 0 ${width} ${height}`}
    role="img"
    aria-label=${title}
    class="burndown-svg"
  ><title>${title}</title>${grid}${ideal}${lines('scope', 'burndown-scope')}${lines('remaining', 'burndown-actual')}${dots}${dates}</svg>`;
}
/**
 * @param {string} className
 * @param {string} text
 */
function burndownLegendItem(className, text) {
  return html`<span class="burndown-legend-item"
    ><span class=${`burndown-swatch ${className}`}></span><span>${text}</span></span
  >`;
}
/** @param {Flux.Burndown} data */
function burndownTable(data) {
  /** @type {[string, 'scope' | 'remaining'][]} */
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
/**
 * @param {readonly Flux.BurndownPoint[]} points
 * @param {'scope' | 'remaining'} key
 */
function latestBurndownPoint(points, key) {
  return [...points].reverse().find((point) => Number.isFinite(point[key]));
}
/**
 * @param {readonly Flux.BurndownPoint[]} points
 * @param {'scope' | 'remaining'} key
 */
function firstBurndownPoint(points, key) {
  return points.find((point) => Number.isFinite(point[key]));
}
/**
 * @param {{ data: Flux.Burndown | undefined, error: { message: string } | undefined,
 *   loading: boolean, reload: () => void }} result
 * @param {(...extra: unknown[]) => unknown} context
 * @param {boolean} busy
 */
function burndownBody(result, context, busy) {
  const { data, error, loading } = result;
  if (error)
    return html`${context()}${errorLineTemplate(error.message)}<button
        type="button"
        disabled=${busy}
        onClick=${result.reload}
      >Retry burn down</button>`;
  if (!data || loading)
    return html`${context()}${emptyStateTemplate('Loading native planning history…')}`;
  if (!data.history_available) return html`${context()}${emptyStateTemplate(data.warning)}`;
  if (!data.points.some((point) => Number.isFinite(point.remaining)))
    return html`${context()}${emptyStateTemplate(
      data.warning || 'No matching work is available for this sprint and filter.',
    )}`;
  // A point with a remaining count exists: the empty case returned above.
  const first = /** @type {Flux.BurndownPoint} */ (firstBurndownPoint(data.points, 'remaining'));
  const latest = /** @type {Flux.BurndownPoint} */ (latestBurndownPoint(data.points, 'remaining'));
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
/**
 * @param {string} root
 * @param {string} sprintID
 * @param {string} project
 * @param {string} assignee
 * @param {number} revision
 * @param {AbortSignal} signal
 * @returns {Promise<Flux.Burndown>}
 */
async function loadBurndown(root, sprintID, project, assignee, revision, signal) {
  // Reads wait for a board refresh to settle, so they are checked against the
  // revision the refresh produces.
  await waitUntil(subscribe, () => !state.loading, signal);
  const query = new URLSearchParams({ sprint: sprintID, project, assignee });
  const next = await api(`${root}/burndown?${query}`, { signal });
  if (!next || !Array.isArray(next.points) || !next.sprint)
    throw new Error('Burn-down data is invalid. Refresh to retry.');
  if (next.revision !== revision)
    throw new Error('Planning changed while loading. Refresh to review.');
  return next;
}
/** @param {Flux.State} current */
function selectBurndownInputs(current) {
  return [
    current.root,
    current.board?.workspace.revision || 0,
    singleFilterValue('project', current.filters),
    singleFilterValue('assignee', current.filters),
  ].join('\u0000');
}
// The chart reads the server's native planning history for the sprint and the
// single project and assignee filter. Each revision or filter change is a new
// request; while any chart loads, the content body is busy.
/** @param {{ sprint: Flux.Sprint }} props */
function BurndownPanel({ sprint }) {
  const inputs = useStore(selectBurndownInputs);
  const filters = useStore((current) => current.filters);
  const lookups = useStore(selectLookups);
  const { busy } = usePermissions();
  const [root, revision, project, assignee] = inputs.split('\u0000');
  const result = useRequest(
    (signal) => loadBurndown(root, sprint.id, project, assignee, Number(revision), signal),
    [inputs, sprint.id],
  );
  useEffect(() => {
    if (!result.loading) return undefined;
    setState((current) => ({ burndownPending: current.burndownPending + 1 }));
    return () => setState((current) => ({ burndownPending: current.burndownPending - 1 }));
  }, [result.loading]);
  const headingID = `burndown-heading-${sprint.id}`;
  const filterCondition = html`<div class="burndown-filter-condition">
    <p class="muted">${`Project: ${selectedFilterText(lookups, 'project', filters)}`}</p>
    <p class="muted">${`Assignee: ${selectedFilterText(lookups, 'assignee', filters)}`}</p>
  </div>`;
  const context = (/** @type {unknown[]} */ ...extra) => html`<div class="burndown-context">
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
  >${burndownBody(result, context, busy)}</section>`;
}
/** @param {Flux.Sprint} sprint */
export function burndownTemplate(sprint) {
  return html`<${BurndownPanel} key=${sprint.id} sprint=${sprint} />`;
}
