// The delivery-trend (velocity) panel on the Sprints page.
import { panelHeadTemplate, emptyStateTemplate, metricListTemplate } from './layout.js';
import { html } from './vdom.js';
import { done } from './items.js';
import { sprintFilterItems, sprintMatchesFilters } from './filters.js';

// Delivery trend is derived from preserved closed-sprint scope and the current
// state of those cards. It is a live read of native planning records, not a
// recorded historical metric, so it is labeled as such.
const VELOCITY_SPRINTS = 8;
/** @typedef {{ sprint: Flux.Sprint, committed: number, completed: number }} VelocityEntry */
/**
 * @param {Flux.Board} board
 * @param {Flux.Lookups} lookups
 * @param {Pick<Flux.Filters, 'project' | 'assignee'>} filters
 * @returns {VelocityEntry[]}
 */
function velocitySeries(board, lookups, filters) {
  return board.sprints
    .filter((sprint) => sprint.state === 'closed' && sprintMatchesFilters(board, sprint, filters))
    .map((sprint) => {
      const items = sprintFilterItems(board, sprint, filters);
      const completed = items.filter((item) => done(lookups, item)).length;
      return { sprint, committed: items.length, completed };
    })
    .slice(-VELOCITY_SPRINTS);
}
/** @param {VelocityEntry[]} series */
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
  const y = (/** @type {number} */ value) => top + ((maximum - value) / maximum) * plotHeight;
  const title = 'Committed and completed work per closed sprint';
  const grid = [
    ...new Set(Array.from({ length: 4 }, (_, index) => Math.round(maximum * (1 - index / 3)))),
  ].map(
    (value) =>
      html`<line class="velocity-grid" x1=${left} x2=${width - right} y1=${y(value)} y2=${y(value)}></line><text class="velocity-axis-label" x=${left - 8} y=${y(value) + 4} text-anchor="end">${String(value)}</text>`,
  );
  const bars = series.map((entry, index) => {
    const center = left + band * (index + 0.5);
    const bar = (
      /** @type {string} */ kind,
      /** @type {number} */ value,
      /** @type {number} */ x,
    ) =>
      html`<rect class=${`velocity-bar velocity-bar-${kind}`} x=${x} y=${y(value)} width=${barWidth} height=${Math.max(1, y(0) - y(value))}><title>${`${entry.sprint.name} · ${value} ${kind}`}</title></rect>`;
    const name =
      entry.sprint.name.length > 14 ? `${entry.sprint.name.slice(0, 13)}…` : entry.sprint.name;
    return html`${bar('committed', entry.committed, center - barWidth - 2)}${bar('completed', entry.completed, center + 2)}<text class="velocity-axis-label" x=${center} y=${height - 14} text-anchor="middle">${name}</text>`;
  });
  return html`<svg
    viewBox=${`0 0 ${width} ${height}`}
    role="img"
    aria-label=${title}
    class="velocity-svg"
  ><title>${title}</title>${grid}${bars}</svg>`;
}
/** @param {VelocityEntry[]} series */
function velocityTable(series) {
  // The <details> open state belongs to the user; the template never binds it.
  return html`<details class="velocity-data" data-state-key="velocity-data">
    <summary>View sprint values</summary>
    <div class="velocity-table-scroll">
      <table>
        <caption>Closed-sprint scope and current completion</caption>
        <thead>
          <tr>
            <th scope="col">Sprint</th>
            <th scope="col">Committed</th>
            <th scope="col">Completed</th>
          </tr>
        </thead>
        <tbody>
          ${series.map(
            (entry) => html`<tr>
              <th scope="row">${entry.sprint.name}</th>
              <td>${String(entry.committed)}</td>
              <td>${String(entry.completed)}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>
  </details>`;
}
/**
 * @param {Flux.Board} board
 * @param {VelocityEntry[]} series
 */
function velocityBody(board, series) {
  if (!series.length) {
    const narrowed = board.sprints.some((sprint) => sprint.state === 'closed');
    return emptyStateTemplate(
      narrowed
        ? 'No closed sprint holds work matching the current filters.'
        : 'No closed sprint yet. Close a sprint to start a delivery trend.',
    );
  }
  const completed = series.map((entry) => entry.completed);
  const average = completed.reduce((sum, value) => sum + value, 0) / completed.length;
  const legend = [
    ['committed', 'Committed'],
    ['completed', 'Completed'],
  ].map(
    ([kind, text]) =>
      html`<span class="velocity-legend-item"
        ><span class=${`velocity-swatch velocity-swatch-${kind}`}></span><span>${text}</span></span
      >`,
  );
  return html`${metricListTemplate(
    [
      [/** @type {VelocityEntry} */ (series.at(-1)).completed, 'Last sprint'],
      [Math.round(average * 10) / 10, 'Average completed'],
      [Math.max(...completed), 'Best sprint'],
    ],
    'velocity-metrics',
  )}
    <figure class="velocity-figure">
      ${velocityChart(series)}
      <div class="velocity-legend">${legend}</div>
    </figure>
    ${velocityTable(series)}`;
}
/**
 * @param {Flux.Board} board
 * @param {Flux.Lookups} lookups
 * @param {Pick<Flux.Filters, 'project' | 'assignee'>} filters
 */
export function sprintVelocityTemplate(board, lookups, filters) {
  return html`<section class="panel velocity-panel" aria-labelledby="velocity-heading">
    ${panelHeadTemplate('Delivery trend', {
      id: 'velocity-heading',
      description: `Committed and completed work for the last ${VELOCITY_SPRINTS} closed sprints. Completion reflects each card's current column, not its state at closure.`,
    })}
    ${velocityBody(board, velocitySeries(board, lookups, filters))}
  </section>`;
}
