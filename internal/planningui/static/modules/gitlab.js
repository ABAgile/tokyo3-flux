// GitLab links and cached observations on cards, rows and the observations dialog.
import { requestKey } from './api.js';
import { helpTextTemplate, emptyStateTemplate } from './layout.js';
import { html } from './vdom.js';
import { useEffect, useState, h } from './vendor-preact.js';
import { state, useStore, requireBoard } from './state.js';
import { writable } from './permissions.js';
import { change } from './commands.js';
import { openDialog, setEditorError } from './dialog-state.js';
import { FormDialog } from './dialog.js';
import { useObservationTooltip } from './tooltip.js';

/**
 * @param {Flux.Link} link
 * @param {boolean} [includeTitle]
 */
export function linkDisplayName(link, includeTitle = true) {
  const name = `${link.kind === 'mr' ? 'MR !' : 'Pipeline #'}${link.number} · project ${link.project}`;
  return includeTitle && link.observation?.title ? `${name} · ${link.observation.title}` : name;
}
/** @param {Flux.Link} link */
function linkLabel(link) {
  return `${link.kind === 'mr' ? 'MR !' : 'Pipeline #'}${link.number}`;
}
/** @param {Flux.Link} link */
function mergeRequestLinkURL(link) {
  if (typeof link.observation?.url === 'string' && link.observation.url)
    return link.observation.url;
  const source = link.observation?.pipeline?.url;
  if (link.kind !== 'mr' || !source) return '';
  try {
    const parsed = new URL(source);
    const marker = '/-/pipelines/';
    const markerAt = parsed.pathname.lastIndexOf(marker);
    if (markerAt <= 0 || !link.number) return '';
    parsed.pathname = `${parsed.pathname.slice(0, markerAt)}/-/merge_requests/${link.number}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}
/**
 * @param {Flux.Link} link
 * @param {string} [focusKey]
 */
export function cardLinkTemplate(link, focusKey) {
  const url = link.kind === 'mr' ? mergeRequestLinkURL(link) : link.observation?.url;
  const key = focusKey || `link:${link.id}`;
  const title = link.observation?.title || linkDisplayName(link, false);
  if (!url)
    return html`<span
      class="card-link"
      data-link-id=${link.id}
      data-observation="link"
      data-focus-key=${key}
      title=${title}
    >${linkLabel(link)}</span>`;
  return html`<a
    class="card-link"
    data-link-id=${link.id}
    data-observation="link"
    data-focus-key=${key}
    title=${title}
    href=${url}
    target="_blank"
    rel="noopener noreferrer"
  >${linkLabel(link)}</a>`;
}
/**
 * @param {Flux.Link} link
 * @param {Flux.Pipeline | null | undefined} pipeline
 */
function pipelineLinkURL(link, pipeline) {
  if (typeof pipeline?.url === 'string' && pipeline.url) return pipeline.url;
  const source = link.observation?.url;
  if (!source) return '';
  if (link.kind === 'pipeline') return source;
  try {
    const parsed = new URL(source);
    const marker = '/-/merge_requests/';
    const markerAt = parsed.pathname.lastIndexOf(marker);
    if (markerAt <= 0 || !pipeline?.id) return '';
    parsed.pathname = `${parsed.pathname.slice(0, markerAt)}/-/pipelines/${pipeline.id}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}
/** @param {Flux.Link} link */
function pipelineLinkTemplate(link) {
  const pipeline = link.observation?.pipeline;
  if (!pipeline) return null;
  const url = pipelineLinkURL(link, pipeline);
  const title = link.kind === 'mr' ? 'Latest pipeline for this merge request' : 'GitLab pipeline';
  const text = `Pipeline #${pipeline.id}`;
  return url
    ? html`<a class="card-link" title=${title} href=${url} target="_blank" rel="noopener noreferrer"
        >${text}</a
      >`
    : html`<span class="card-link" title=${title}>${text}</span>`;
}
/** @param {Flux.Link} link */
function observationOutcomeText(link) {
  /** @type {Record<string, string>} */
  const outcomes = {
    unobserved: 'Not observed',
    ok: 'Observed',
    inaccessible: 'Access denied',
    not_found: 'Not found or hidden',
    unavailable: 'Unavailable',
    invalid_response: 'Invalid response',
    rate_limited: 'Rate limited',
    busy: 'Connector busy',
    disabled: 'Disabled',
    outdated: 'Older result ignored',
    refreshing: 'Refresh pending',
  };
  return outcomes[link.outcome] || 'Observation unavailable';
}
/** @param {Flux.Link} link */
function observationIsStale(link) {
  if (link.refresh_pending || link.outcome === 'refreshing') return true;
  if (!link.last_success) return false;
  const timestamp = Date.parse(link.last_success);
  return Number.isNaN(timestamp) || Date.now() - timestamp > 5 * 60 * 1000 || link.outcome !== 'ok';
}
/** @param {Flux.Link} link */
function observationTooltip(link) {
  const observation = link.observation;
  const parts = [];
  if (observation?.title) parts.push(observation.title);
  if (observation?.mr_state)
    parts.push(`MR: ${observation.mr_state}${observation.draft ? ' · draft' : ''}`);
  if (observation?.pipeline) parts.push(`Pipeline: ${observation.pipeline.state || 'unknown'}`);
  if (!observation || link.outcome !== 'ok') parts.push(observationOutcomeText(link));
  if (observationIsStale(link)) parts.push('Stale');
  parts.push(observationTiming(link));
  return `${linkLabel(link)} · ${parts.join(' · ')}`;
}
/** @param {Flux.Link} link */
function observationIconState(link) {
  if (link.refresh_pending || link.outcome === 'refreshing')
    return { symbol: '↻', status: 'pending', stale: true };
  if (!link.observation)
    return {
      symbol: link.outcome && link.outcome !== 'unobserved' && link.outcome !== 'ok' ? '!' : '?',
      status:
        link.outcome && link.outcome !== 'unobserved' && link.outcome !== 'ok'
          ? 'warning'
          : 'unknown',
      stale: false,
    };
  if (link.outcome && link.outcome !== 'ok')
    return { symbol: '!', status: 'warning', stale: observationIsStale(link) };
  const state = String(link.observation.mr_state || '').toLowerCase();
  if (state === 'merged') return { symbol: '✓', status: 'merged', stale: observationIsStale(link) };
  if (state === 'closed') return { symbol: '×', status: 'closed', stale: observationIsStale(link) };
  if (link.observation.draft)
    return { symbol: '◐', status: 'draft', stale: observationIsStale(link) };
  if (state === 'opened') return { symbol: '●', status: 'open', stale: observationIsStale(link) };
  return { symbol: '?', status: 'unknown', stale: observationIsStale(link) };
}
/** @param {{ link: Flux.Link, focusKey?: string }} props */
function ObservationIcon({ link, focusKey }) {
  const icon = observationIconState(link);
  const text = observationTooltip(link);
  const tooltip = useObservationTooltip();
  return html`<span
    class="card-observation-icon"
    data-link-id=${link.id}
    data-observation="status-icon"
    data-status=${icon.status}
    data-stale=${String(icon.stale)}
    data-focus-key=${focusKey || `link:${link.id}:observation`}
    data-tooltip=${text}
    role="img"
    aria-label=${`Card observation: ${text}`}
    tabindex="0"
    ref=${tooltip.ref}
    style=${tooltip.style}
    ...${tooltip.props}
  >${icon.symbol}</span>`;
}
/**
 * @param {Flux.Link} link
 * @param {string} [focusKey]
 */
export function cardObservationIconTemplate(link, focusKey) {
  return html`<${ObservationIcon} key=${`observation:${link.id}`} link=${link} focusKey=${focusKey} />`;
}
/** @param {Flux.Link} link */
function observationTiming(link) {
  const timestamp = (/** @type {string | null | undefined} */ value) => {
    if (!value) return 'none yet';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'unavailable' : date.toLocaleString();
  };
  return `Last successful refresh: ${timestamp(link.last_success)} · Latest refresh attempt: ${timestamp(link.last_attempt)}`;
}
/** @type {Record<string, string>} */
const LINK_OUTCOMES = {
  unobserved: 'Not refreshed',
  ok: 'Last attempt succeeded',
  inaccessible: 'GitLab denied access',
  not_found: 'Not found or hidden by GitLab',
  unavailable: 'GitLab unavailable',
  invalid_response: 'Invalid GitLab response',
  rate_limited: 'GitLab rate limited',
  busy: 'Connector busy',
  disabled: 'Connector disabled',
  outdated: 'Older provider version ignored; cached data retained',
  refreshing: 'Refresh requested; retry after cooldown if interrupted',
};
/**
 * @param {Flux.Item} item
 * @param {Flux.Link} link
 * @param {string} key
 */
async function refreshObservation(item, link, key) {
  if (!writable()) return;
  try {
    await change(
      { kind: 'link.refresh', target: link.id, revision: requireBoard().workspace.revision },
      key,
    );
    const latest = state.board?.items.find((i) => i.id === item.id);
    if (latest) showLinks(latest);
  } catch (e) {
    setEditorError(
      `${e.message} Refresh the board to see current status; cooldowns prevent duplicate requests.`,
    );
  }
}
/** @param {{ item: Flux.Item, link: Flux.Link }} props */
function LinkObservation({ item, link }) {
  const board = useStore((current) => current.board);
  const busy = useStore((current) => current.busy);
  const loading = useStore((current) => current.loading);
  const [now, setNow] = useState(Date.now());
  const [request] = useState(requestKey);
  useEffect(() => {
    if (!link.next_refresh) return;
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, [link.next_refresh]);
  const ready =
    board?.connector_instance && board.connector_instance === board.integration.instance;
  const obs = link.observation;
  const next = link.next_refresh && Date.parse(link.next_refresh) > now;
  const disabled =
    !board ||
    board.role === 'viewer' ||
    busy ||
    loading ||
    !ready ||
    (!!link.next_refresh && Date.parse(link.next_refresh) > now);
  return html`<article class="setup-row" data-link-id=${link.id}>
    <div class="card-links">${cardLinkTemplate(link)}${pipelineLinkTemplate(link)}</div>
    ${obs?.title ? html`<p>${obs.title}</p>` : null}
    ${
      obs?.mr_state
        ? helpTextTemplate(
            `${obs.draft ? 'Draft · ' : ''}Review/mergeability: ${obs.review || 'unknown'} · Head SHA ${obs.head_sha || 'unknown'}`,
          )
        : null
    }
    ${
      obs?.pipeline
        ? helpTextTemplate(
            `${link.kind === 'mr' ? 'Latest MR pipeline status' : 'Pipeline status'}: ${obs.pipeline.state || 'unknown'} · SHA ${obs.pipeline.sha || 'unknown'} · Provider state ${obs.pipeline.provider_state || 'unknown'}`,
          )
        : null
    }
    ${helpTextTemplate(LINK_OUTCOMES[link.outcome] || 'Unknown outcome')}
    ${helpTextTemplate(observationTiming(link))}
    ${
      link.next_refresh
        ? html`<p class="help" data-observation="next-refresh" hidden=${!next}
            >${next ? `Next refresh after ${new Date(link.next_refresh).toLocaleTimeString()}. The refresh control becomes available after that time.` : ''}</p
          >`
        : null
    }
    <div class="actions">
      <button
        type="button"
        data-refresh-link=${link.id}
        disabled=${disabled}
        onClick=${() => refreshObservation(item, link, request)}
      >Refresh observation</button>
    </div>
  </article>`;
}
// The observations dialog is a snapshot of the card's links when it opened;
// refresh controls follow the live board and busy state.
/** @param {Flux.Item} item */
export function showLinks(item) {
  const board = requireBoard();
  openDialog('links.show', {
    item,
    links: board.links.filter((l) => l.items.includes(item.id)),
    instance: board.integration.instance,
    refreshSeconds: board.refresh_seconds,
    ready: !!board.connector_instance && board.connector_instance === board.integration.instance,
  });
}
/** @param {Flux.DialogProps['links.show']} props */
export function LinksDialog({ item, links, instance, refreshSeconds, ready }) {
  return h(
    FormDialog,
    { title: 'Linked GitLab observations', readOnly: true },
    html`
      ${helpTextTemplate(`${item.title} · ${instance || 'No approved integration'}`)}
      ${helpTextTemplate(
        `Engineering observations only. Refresh does not move cards or change sprint scope. ${refreshSeconds ? `Background refresh: about every ${refreshSeconds} seconds, with backoff on failures. Webhook hints can request an earlier refresh.` : 'Automatic refresh is disabled; use manual refresh.'} Observations older than five minutes or awaiting refresh are stale. This dialog is a snapshot; reopen to see background results.`,
      )}
      ${
        links.length
          ? null
          : emptyStateTemplate('Unlinked. Add an approved MR; never infer links from card titles.')
      }
      ${links.map((link) => html`<${LinkObservation} key=${link.id} item=${item} link=${link} />`)}
      ${
        ready
          ? null
          : helpTextTemplate(
              'Connector unavailable or instance approval needs updating. An admin can review Projects settings.',
            )
      }
    `,
  );
}
