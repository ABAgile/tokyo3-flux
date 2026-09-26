// GitLab links and cached observations on cards, rows and the observations dialog.
import { $, syncAttributes } from './dom.js';
import { requestKey } from './api.js';
import { helpTextTemplate, emptyStateTemplate } from './layout.js';
import { hooks } from './hooks.js';
import { html, nodeOf, nothing } from './preact.js';
import { state } from './state.js';
import { writable } from './permissions.js';
import { change } from './commands.js';
import { openEditor } from './dialog.js';

export function linkDisplayName(link, includeTitle = true) {
  const name = `${link.kind === 'mr' ? 'MR !' : 'Pipeline #'}${link.number} · project ${link.project}`;
  return includeTitle && link.observation?.title ? `${name} · ${link.observation.title}` : name;
}
function linkLabel(link) {
  return `${link.kind === 'mr' ? 'MR !' : 'Pipeline #'}${link.number}`;
}
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
export function cardLinkView(link, focusKey) {
  return nodeOf(cardLinkTemplate(link, focusKey));
}
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
function pipelineLinkTemplate(link) {
  const pipeline = link.observation?.pipeline;
  if (!pipeline) return nothing;
  const url = pipelineLinkURL(link, pipeline);
  const title = link.kind === 'mr' ? 'Latest pipeline for this merge request' : 'GitLab pipeline';
  const text = `Pipeline #${pipeline.id}`;
  return url
    ? html`<a class="card-link" title=${title} href=${url} target="_blank" rel="noopener noreferrer"
        >${text}</a
      >`
    : html`<span class="card-link" title=${title}>${text}</span>`;
}
function observationOutcomeText(link) {
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
function observationIsStale(link) {
  if (link.refresh_pending || link.outcome === 'refreshing') return true;
  if (!link.last_success) return false;
  const timestamp = Date.parse(link.last_success);
  return Number.isNaN(timestamp) || Date.now() - timestamp > 5 * 60 * 1000 || link.outcome !== 'ok';
}
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
function observationIconTarget(target) {
  return target instanceof Element ? target.closest('.card-observation-icon') : undefined;
}
function positionObservationTooltip(target) {
  const tooltipStyle = getComputedStyle(target, '::after');
  const width = Number.parseFloat(tooltipStyle.width) || 320;
  const height = Number.parseFloat(tooltipStyle.height) || 0;
  const rootStyle = getComputedStyle(document.documentElement);
  const gap = Number.parseFloat(rootStyle.getPropertyValue('--s1')) || 4;
  const edge = Number.parseFloat(rootStyle.getPropertyValue('--s4')) || 16;
  const targetBox = target.getBoundingClientRect();
  const maxLeft = Math.max(edge, innerWidth - width - edge);
  const left = Math.min(Math.max(edge, targetBox.left), maxLeft);
  const below = targetBox.bottom + gap;
  const top =
    below + height <= innerHeight - edge ? below : Math.max(edge, targetBox.top - gap - height);
  target.style.setProperty('--observation-tooltip-left', `${Math.round(left)}px`);
  target.style.setProperty('--observation-tooltip-top', `${Math.round(top)}px`);
}
function repositionObservationTooltip() {
  const target = state.observationTooltipTarget;
  if (!target?.isConnected || (!target.matches(':hover') && document.activeElement !== target)) {
    state.observationTooltipTarget = undefined;
    return;
  }
  positionObservationTooltip(target);
}
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
export function cardObservationIconTemplate(link, focusKey) {
  const icon = observationIconState(link);
  const tooltip = observationTooltip(link);
  return html`<span
    class="card-observation-icon"
    data-link-id=${link.id}
    data-observation="status-icon"
    data-status=${icon.status}
    data-stale=${String(icon.stale)}
    data-focus-key=${focusKey || `link:${link.id}:observation`}
    data-tooltip=${tooltip}
    role="img"
    aria-label=${`Card observation: ${tooltip}`}
    tabindex="0"
  >${icon.symbol}</span>`;
}
export function cardObservationIcon(link, focusKey) {
  return nodeOf(cardObservationIconTemplate(link, focusKey));
}
export function linkIdentitySignature(link) {
  return JSON.stringify({
    id: link.id,
    project: link.project,
    kind: link.kind,
    number: link.number,
    items: [...(link.items || [])].sort(),
  });
}
function observationSignature(link) {
  return JSON.stringify({
    observation: link.observation || null,
    last_success: link.last_success || null,
    last_attempt: link.last_attempt || null,
    outcome: link.outcome || '',
    next_refresh: link.next_refresh || null,
    refresh_pending: !!link.refresh_pending,
  });
}
export function patchObservationIcon(node, link) {
  const replacement = cardObservationIcon(link, node.dataset.focusKey);
  if (node.tagName === replacement.tagName) {
    syncAttributes(node, replacement);
    if (node.textContent !== replacement.textContent) node.textContent = replacement.textContent;
    if (state.observationTooltipTarget === node) positionObservationTooltip(node);
    return node;
  }
  node.replaceWith(replacement);
  return replacement;
}
export function patchObservationLink(node, link) {
  const replacement = cardLinkView(link, node.dataset.focusKey);
  if (node.tagName === replacement.tagName) {
    syncAttributes(node, replacement);
    if (node.textContent !== replacement.textContent) node.textContent = replacement.textContent;
    return node;
  }
  node.replaceWith(replacement);
  return replacement;
}
function refreshLinkDisabled(link) {
  return (
    !writable() ||
    !link ||
    !state.board.connector_instance ||
    state.board.connector_instance !== state.board.integration.instance ||
    (!!link.next_refresh && Date.parse(link.next_refresh) > Date.now())
  );
}
export function patchRefreshControl(node, link) {
  node.disabled = refreshLinkDisabled(link);
  const row = node.closest('.setup-row');
  const next = row?.querySelector('[data-observation="next-refresh"]');
  if (next) {
    next.hidden = !link?.next_refresh || Date.parse(link.next_refresh) <= Date.now();
    if (!next.hidden)
      next.textContent = `Next refresh after ${new Date(link.next_refresh).toLocaleTimeString()}. The refresh control becomes available after that time.`;
  }
}
export function patchObservationUI(previousLinks, nextLinks) {
  const previous = new Map(previousLinks.map((link) => [link.id, link]));
  const changed = nextLinks.filter(
    (link) =>
      previous.has(link.id) &&
      observationSignature(previous.get(link.id)) !== observationSignature(link),
  );
  if (!changed.length) return false;
  // Cards and list rows are Preact templates: re-render them rather than patching
  // their nodes.
  let cards = false;
  const patch = (node, link, patcher) => {
    if (node.dataset.linkId !== link.id) return;
    if (node.closest('.card,.list-row')) cards = true;
    else patcher(node, link);
  };
  changed.forEach((link) => {
    for (const node of document.querySelectorAll('[data-observation="status-icon"]'))
      patch(node, link, patchObservationIcon);
    for (const node of document.querySelectorAll('[data-observation="link"]'))
      patch(node, link, patchObservationLink);
    document.querySelectorAll('[data-refresh-link]').forEach((node) => {
      if (node.dataset.refreshLink === link.id) patchRefreshControl(node, link);
    });
  });
  if (cards) {
    hooks.renderContent();
    if (state.observationTooltipTarget?.isConnected)
      positionObservationTooltip(state.observationTooltipTarget);
  }
  return true;
}
function observationTiming(link) {
  const timestamp = (value) => {
    if (!value) return 'none yet';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'unavailable' : date.toLocaleString();
  };
  return `Last successful refresh: ${timestamp(link.last_success)} · Latest refresh attempt: ${timestamp(link.last_attempt)}`;
}
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
async function refreshObservation(item, link, key) {
  if (!writable()) return;
  try {
    await change(
      { kind: 'link.refresh', target: link.id, revision: state.board.workspace.revision },
      key,
    );
    $('editor').close();
    showLinks(state.board.items.find((i) => i.id === item.id));
  } catch (e) {
    $('form-error').textContent =
      `${e.message} Refresh the board to see current status; cooldowns prevent duplicate requests.`;
  }
}
// The dialog is a snapshot rendered once per opening and never re-rendered,
// so after creation its refresh controls and next-refresh lines belong to
// patchRefreshControl, which the observation poll calls. Observation links
// are rendered once too; Board/List instead re-render their current VNodes.
function linkObservationTemplate(item, link, ready) {
  const obs = link.observation;
  const next = link.next_refresh && Date.parse(link.next_refresh) > Date.now();
  const key = requestKey();
  return html`<article class="setup-row" data-link-id=${link.id}>
    <div class="card-links">${cardLinkTemplate(link)}${pipelineLinkTemplate(link)}</div>
    ${obs?.title ? html`<p>${obs.title}</p>` : nothing}
    ${
      obs?.mr_state
        ? helpTextTemplate(
            `${obs.draft ? 'Draft · ' : ''}Review/mergeability: ${obs.review || 'unknown'} · Head SHA ${obs.head_sha || 'unknown'}`,
          )
        : nothing
    }
    ${
      obs?.pipeline
        ? helpTextTemplate(
            `${link.kind === 'mr' ? 'Latest MR pipeline status' : 'Pipeline status'}: ${obs.pipeline.state || 'unknown'} · SHA ${obs.pipeline.sha || 'unknown'} · Provider state ${obs.pipeline.provider_state || 'unknown'}`,
          )
        : nothing
    }
    ${helpTextTemplate(LINK_OUTCOMES[link.outcome] || 'Unknown outcome')}
    ${helpTextTemplate(observationTiming(link))}
    ${
      link.next_refresh
        ? html`<p class="help" data-observation="next-refresh" hidden=${!next}
            >${next ? `Next refresh after ${new Date(link.next_refresh).toLocaleTimeString()}. The refresh control becomes available after that time.` : ''}</p
          >`
        : nothing
    }
    <div class="actions">
      <button
        type="button"
        data-refresh-link=${link.id}
        disabled=${refreshLinkDisabled(link) || !ready}
        onClick=${() => refreshObservation(item, link, key)}
      >Refresh observation</button>
    </div>
  </article>`;
}
export function showLinks(item) {
  const ready =
    state.board.connector_instance &&
    state.board.connector_instance === state.board.integration.instance;
  const links = state.board.links.filter((l) => l.items.includes(item.id));
  openEditor(
    'Linked GitLab observations',
    () => html`${helpTextTemplate(
      `${item.title} · ${state.board.integration.instance || 'No approved integration'}`,
    )}
      ${helpTextTemplate(
        `Engineering observations only. Refresh does not move cards or change sprint scope. ${state.board.refresh_seconds ? `Background refresh: about every ${state.board.refresh_seconds} seconds, with backoff on failures. Webhook hints can request an earlier refresh.` : 'Automatic refresh is disabled; use manual refresh.'} Observations older than five minutes or awaiting refresh are stale. This dialog is a snapshot; reopen to see background results.`,
      )}
      ${
        links.length
          ? nothing
          : emptyStateTemplate('Unlinked. Add an approved MR; never infer links from card titles.')
      }
      ${links.map((link) => linkObservationTemplate(item, link, ready))}
      ${
        ready
          ? nothing
          : helpTextTemplate(
              'Connector unavailable or instance approval needs updating. An admin can review Projects settings.',
            )
      }`,
    () => ({}),
    true,
  );
}
// Registers the observation tooltip listeners; app.js calls this once at startup.
export function initObservationTooltips() {
  document.addEventListener('pointerover', (e) => {
    const target = observationIconTarget(e.target);
    if (target && !(e.relatedTarget instanceof Node && target.contains(e.relatedTarget))) {
      state.observationTooltipTarget = target;
      positionObservationTooltip(target);
    }
  });
  document.addEventListener('pointerout', (e) => {
    const target = observationIconTarget(e.target);
    if (
      !target ||
      (e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) ||
      target.matches(':hover') ||
      target.contains(document.activeElement)
    )
      return;
    if (state.observationTooltipTarget === target) state.observationTooltipTarget = undefined;
  });
  document.addEventListener('focusin', (e) => {
    const target = observationIconTarget(e.target);
    if (target) {
      state.observationTooltipTarget = target;
      positionObservationTooltip(target);
    }
  });
  document.addEventListener('focusout', (e) => {
    const target = observationIconTarget(e.target);
    if (
      !target ||
      (e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) ||
      target.matches(':hover')
    )
      return;
    if (state.observationTooltipTarget === target) state.observationTooltipTarget = undefined;
  });
  window.addEventListener('resize', repositionObservationTooltip);
  document.addEventListener('scroll', repositionObservationTooltip, true);
}
