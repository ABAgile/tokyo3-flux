'use strict';
const $ = id => document.getElementById(id);
let session, workspaces = [], board, root, view = 'board', busy = false, loading = false;
let history = [], historyBefore = 0, historyMore = false, loadGeneration = 0;
let integrationFormOpen = false, integrationCatalog = [], integrationCatalogError = '', integrationCatalogLoading = false;
let burndownData = new Map(), burndownRequests = new Map(), burndownErrors = new Map(), burndownExpanded = new Set(), burndownGeneration = 0;
const theme = localStorage.getItem('flux-plan-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = theme;
const LABEL_PALETTE = Object.freeze([
 '#ff6b6b', '#f94144', '#e63946', '#d62828', '#c1121f', '#a4161a', '#8d0801', '#6a040f',
 '#ff9f1c', '#ff8500', '#f77f00', '#e76f00', '#d95d00', '#c75100', '#aa4a00', '#833800',
 '#ffe066', '#ffd166', '#ffcc00', '#fcbf49', '#f9c74f', '#e9c46a', '#d4a72c', '#8f6d00',
 '#dcefe4', '#90be6d', '#70ad47', '#52b788', '#40916c', '#2d6a4f', '#237a57', '#14532d',
 '#2ec4b6', '#20a39e', '#00a896', '#0a9396', '#087f8f', '#147d92', '#145a42', '#0b525b',
 '#4dabf7', '#339af0', '#228be6', '#1971c2', '#1864ab', '#155e75', '#0d4f8b', '#0b3d91',
 '#748ffc', '#5c7cfa', '#4c6ef5', '#4263eb', '#364fc7', '#3f37c9', '#3730a3', '#2b2d6e',
 '#c77dff', '#b26fff', '#9d4edd', '#8338ec', '#7209b7', '#6a0dad', '#5a189a', '#3c096c'
]);
function el(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function updateThemeControl() { const dark = document.documentElement.dataset.theme === 'dark'; $('theme').firstElementChild.textContent = dark ? '☀' : '☾'; $('theme').title = dark ? 'Switch to light theme' : 'Switch to dark theme'; }
$('theme').onclick = () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; localStorage.setItem('flux-plan-theme', next); updateThemeControl(); };
updateThemeControl();
function button(text, fn, className) { const b = el('button', text, className); b.type = 'button'; b.onclick = fn; return b; }
function writable() { return board && board.role !== 'viewer' && !busy && !loading; }
function gitLabWritable() { return writable() && !!board.connector_instance && board.connector_instance === board.integration.instance && !!board.integration.projects.length; }
function canComment() { return board && (board.role === 'member' || board.role === 'admin') && !busy && !loading; }
function writeButton(text, fn, className) { const b = button(text, fn, className); b.disabled = !writable() || integrationFormOpen; return b; }
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
function options(select, entries, value) { select.replaceChildren(...entries.map(([id, text]) => { const o = el('option', text); o.value = id; return o; })); if (value !== undefined) select.value = value; }
async function api(path, init = {}) { const r = await fetch(path, { ...init, headers: { 'Accept': 'application/json', ...init.headers } }); if (r.redirected) throw new Error('Session expired. Reload the page to sign in.'); let data; try { data = await r.json(); } catch { throw new Error('Planning service unavailable. Refresh to retry.'); } if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`); return data; }
function resetBurndown() { burndownGeneration++; burndownData.clear(); burndownRequests.clear(); burndownErrors.clear(); }
async function refresh() {
 if (!root || busy || integrationFormOpen) return;
 const generation = ++loadGeneration; loading = true; renderControls(); $('content').setAttribute('aria-busy', 'true');
 try { const next = await api(root + '/board'); if (generation !== loadGeneration) return false; board = next; resetBurndown(); history = []; historyBefore = 0; if (view === 'history') await loadHistory(true); notice(`Up to date · workspace revision ${board.workspace.revision}`); return true; }
 catch (e) { if (generation === loadGeneration) notice(e.message, true); return false; }
 finally { if (generation === loadGeneration) { loading = false; render(); if (!burndownRequests.size) $('content').setAttribute('aria-busy', 'false'); } }
}
function requestKey() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); }
async function change(command, key = requestKey()) {
 if (!writable()) throw new Error('Planning is read-only or a request is in progress.');
 busy = true; renderControls(); notice('Saving changes…');
 try { await api(root + '/changes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf, 'Idempotency-Key': key }, body: JSON.stringify(command) }); }
 finally { busy = false; renderControls(); }
 const refreshed = await refresh(); notice(refreshed ? 'Changes saved.' : 'Changes saved, but refreshing failed. Use Refresh before continuing.', !refreshed);
}
async function quick(command) { try { await change({ revision: board.workspace.revision, ...command }); } catch (e) { notice(e.message, true); render(); } }
function renderControls() { document.querySelectorAll('[data-write]').forEach(b => { b.disabled = !writable() || integrationFormOpen; }); document.querySelectorAll('[data-gitlab-write]').forEach(b => { b.disabled = !gitLabWritable(); }); document.querySelectorAll('[data-comment-write]').forEach(b => { b.disabled = !canComment(); }); document.querySelectorAll('[data-drag-type]').forEach(e => { e.draggable = writable(); }); document.querySelectorAll('[data-view]').forEach(b => { b.disabled = busy || loading || integrationFormOpen; }); $('refresh').disabled = busy || loading || integrationFormOpen; $('workspace').disabled = busy || loading || integrationFormOpen; $('project').disabled = busy || loading; $('assignee').disabled = busy || loading; $('label').disabled = busy || loading; }
let drag;
function clearDropMarks() { document.querySelectorAll('.drop-before,.drop-after,.drop-end').forEach(e => e.classList.remove('drop-before', 'drop-after', 'drop-end')); }
function makeDraggable(node, type, id, name) {
 node.dataset.dragType = type; node.draggable = writable(); node.setAttribute('aria-label', `Drag ${type} ${name}`);
 node.addEventListener('dragstart', e => {
  if (!writable() || (e.target !== node && e.target.closest?.('button,a,input,select,textarea'))) { e.preventDefault(); return; }
  e.stopPropagation(); drag = {type, id, revision: board.workspace.revision, root}; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id);
 });
 node.addEventListener('dragend', () => { drag = undefined; clearDropMarks(); });
 return node;
}
function dropZone(node, type, command, axis = 'y') {
 function accepts() { return drag?.type === type && drag.root === root && writable(); }
 function after(e) { const r = node.getBoundingClientRect(); return axis === 'x' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2; }
 node.addEventListener('dragover', e => { if (!accepts()) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; clearDropMarks(); node.classList.add(axis === 'end' ? 'drop-end' : after(e) ? 'drop-after' : 'drop-before'); });
 node.addEventListener('dragleave', e => { if (!node.contains(e.relatedTarget)) node.classList.remove('drop-before', 'drop-after', 'drop-end'); });
 node.addEventListener('drop', e => { if (!accepts()) return; e.preventDefault(); e.stopPropagation(); const c = command(drag.id, after(e)); const revision = drag.revision; drag = undefined; clearDropMarks(); if (c && c.target !== c.before) quick({...c, revision}); });
}
function memberInfo(subject) {
 const member = board.members.find(m => m.subject === subject); const name = member?.name || (subject === session?.subject && session.name) || (subject ? `Unnamed member (${subject})` : 'Unassigned');
 return {name, avatarURL: member?.avatar_url || (subject === session?.subject && session.avatar_url) || ''};
}
function memberName(subject) { return memberInfo(subject).name; }
function initials(name) { const words = name.trim().split(/\s+/).filter(Boolean); return words.length ? words.slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase() : '—'; }
function assigneeView(subject) {
 const info = memberInfo(subject); const node = el('span', undefined, 'assignee'); node.setAttribute('aria-label', `Assignee: ${info.name}`); node.title = info.name;
 const avatar = el('span', undefined, 'avatar'); avatar.setAttribute('aria-hidden', 'true'); avatar.append(el('span', initials(info.name), 'avatar-fallback'));
 if (info.avatarURL) { const image = el('img'); image.src = info.avatarURL; image.alt = ''; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.onerror = () => image.remove(); avatar.append(image); }
 node.append(avatar, el('span', info.name)); return node;
}
function linkDisplayName(link, includeTitle = true) {
 const name = `${link.kind === 'mr' ? 'MR !' : 'Pipeline #'}${link.number} · project ${link.project}`;
 return includeTitle && link.observation?.title ? `${name} · ${link.observation.title}` : name;
}
function linkLabel(link) { return `${link.kind === 'mr' ? 'MR !' : 'Pipeline #'}${link.number}`; }
function mergeRequestLinkURL(link) {
 if (typeof link.observation?.url === 'string' && link.observation.url) return link.observation.url;
 const source = link.observation?.pipeline?.url; if (link.kind !== 'mr' || !source) return '';
 try {
  const parsed = new URL(source); const marker = '/-/pipelines/'; const markerAt = parsed.pathname.lastIndexOf(marker);
  if (markerAt <= 0 || !link.number) return '';
  parsed.pathname = `${parsed.pathname.slice(0, markerAt)}/-/merge_requests/${link.number}`; parsed.search = ''; parsed.hash = '';
  return parsed.toString();
 } catch { return ''; }
}
function cardLinkView(link) {
 const url = link.kind === 'mr' ? mergeRequestLinkURL(link) : link.observation?.url; const node = el(url ? 'a' : 'span', linkLabel(link), 'card-link');
 node.title = link.observation?.title || linkDisplayName(link, false);
 if (url) { node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
 return node;
}
function pipelineLinkURL(link, pipeline) {
 if (typeof pipeline?.url === 'string' && pipeline.url) return pipeline.url;
 const source = link.observation?.url;
 if (!source) return '';
 if (link.kind === 'pipeline') return source;
 try {
  const parsed = new URL(source); const marker = '/-/merge_requests/'; const markerAt = parsed.pathname.lastIndexOf(marker);
  if (markerAt <= 0 || !pipeline?.id) return '';
  parsed.pathname = `${parsed.pathname.slice(0, markerAt)}/-/pipelines/${pipeline.id}`; parsed.search = ''; parsed.hash = '';
  return parsed.toString();
 } catch { return ''; }
}
function pipelineLinkView(link) {
 const pipeline = link.observation?.pipeline; if (!pipeline) return null;
 const url = pipelineLinkURL(link, pipeline); const node = el(url ? 'a' : 'span', `Pipeline #${pipeline.id}`, 'card-link');
 node.title = link.kind === 'mr' ? 'Latest pipeline for this merge request' : 'GitLab pipeline';
 if (url) { node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
 return node;
}
function activeSprints() { return board.sprints.filter(s => s.state === 'active'); }
function projectName(id) { return board.projects.find(p => p.id === id)?.name || 'No project'; }
function labelInfo(name) { return board.labels.find(label => label.name === name) || {name, color: '#dcefe4'}; }
function labelForeground(color) {
 const match = /^#([0-9a-f]{6})$/i.exec(color || ''); if (!match) return 'var(--ink)';
 const value = Number.parseInt(match[1], 16); const channels = [value >> 16 & 255, value >> 8 & 255, value & 255].map(channel => { channel /= 255; return channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; });
 const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
 return luminance > .21 ? 'var(--label-ink)' : 'var(--label-contrast)';
}
function labelBadge(name) { const label = labelInfo(name); const badge = el('span', name, 'badge label-badge'); badge.style.backgroundColor = label.color; badge.style.color = labelForeground(label.color); return badge; }
function styleLabelOptions(select) { [...select.options].forEach(option => { const label = labelInfo(option.value); option.style.backgroundColor = label.color; option.style.color = labelForeground(label.color); }); }
function done(item) { return board.columns.find(c => c.id === item.column_id)?.category === 'done'; }
function blocked(item) { return item.dependencies.some(id => { const dep = board.items.find(i => i.id === id); return dep && !done(dep); }); }
function scopeItems(sprint) { return sprint.state === 'closed' ? board.items.filter(i => board.closed_scope.some(s => s.sprint_id === sprint.id && s.item_id === i.id)) : board.items.filter(i => !i.archived && i.sprint_ids.includes(sprint.id)); }
function sprintPanel(s) {
 const panel = el('article', undefined, 'sprint-panel'); const info = el('div', undefined, 'sprint-info'); info.append(el('p', `${s.state.toUpperCase()} SPRINT`, 'eyebrow'), el('h2', s.name), el('p', s.goal), el('small', `${s.start} → ${s.end}`, 'muted'));
 const items = scopeItems(s); const metrics = el('div', undefined, 'metrics');
 for (const [n, label] of [[items.length, 'In scope'], [items.filter(done).length, s.state === 'closed' ? 'Done now' : 'Done'], [items.filter(blocked).length, 'Blocked now']]) { const metric = el('span', undefined, 'metric'); metric.append(el('strong', String(n)), el('span', label)); metrics.append(metric); }
 const actions = el('div', undefined, 'actions');
 const expanded = burndownExpanded.has(s.id); const toggle = button(expanded ? 'Hide burn down' : 'Show burn down', () => { if (expanded) burndownExpanded.delete(s.id); else burndownExpanded.add(s.id); render(); [...document.querySelectorAll('[data-burndown-toggle]')].find(element => element.dataset.burndownToggle === s.id)?.focus(); }, 'quiet'); toggle.dataset.burndownToggle = s.id; toggle.setAttribute('aria-expanded', String(expanded)); if (expanded) toggle.setAttribute('aria-controls', `burndown-${s.id}`); toggle.disabled = busy || loading; actions.append(toggle);
 actions.append(button('View scope', () => { view = 'board'; $('scope').value = s.id; render(); }));
 if (s.state !== 'closed') actions.append(writeButton('Edit sprint', () => editSprint(s)));
 if (s.state === 'planned') actions.append(writeButton('Start sprint', () => quick({ kind: 'sprint.start', target: s.id }), 'primary'));
 if (s.state === 'active') actions.append(writeButton('Close sprint', () => closeSprint(s)));
 if (s.state === 'closed') info.append(el('small', 'Scope preserved at closure. Card details reflect current work; historical state is retained in audit.', 'muted'));
 panel.append(info, metrics, actions); if (expanded) panel.append(renderBurndown(s)); return panel;
}
function render() {
 renderControls();
 if (!board) { $('sprint-summary').replaceChildren(); $('count').textContent = ''; $('content').replaceChildren(el('p', 'Choose an available workspace to begin. Projects are optional.', 'empty')); return; }
 const projectFilter = $('project').value; options($('project'), [['all', 'All projects'], ['none', 'No project'], ...board.projects.map(p => [p.id, p.name])], projectFilter); if (!$('project').value) $('project').value = 'all';
 const assigneeFilter = $('assignee').value; options($('assignee'), [['all', 'All assignees'], ['none', 'Unassigned'], ...board.members.map(m => [m.subject, memberName(m.subject)])], assigneeFilter); if (!$('assignee').value) $('assignee').value = 'all';
 const labelFilter = $('label').value; options($('label'), [['all', 'All labels'], ['none', 'No labels'], ...board.labels.map(label => [label.name, label.name])], labelFilter); if (!$('label').value) $('label').value = 'all'; styleLabelOptions($('label'));
 const titles = { board: 'Kanban board', sprints: 'Sprints', projects: 'Projects', labels: 'Labels', members: 'Members', archive: 'Archive', history: 'History' };
 const subtitles = { projects: 'Organize workspace projects and GitLab integration.', labels: 'Maintain labels used to classify work.', members: 'Review workspace members and maintain display names.' };
 $('title').textContent = titles[view]; $('subtitle').textContent = board.role === 'viewer' ? 'Read-only workspace access.' : subtitles[view] || 'Plan intentionally. Keep work moving.';
 document.querySelectorAll('[data-view]').forEach(b => { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
 const active = activeSprints();
 const selected = $('scope').value; options($('scope'), [['active', 'Active sprints'], ['backlog', 'Backlog'], ['all', 'All open work'], ...board.sprints.map(s => [s.id, `${s.name} (${s.state})`])], selected); if (!$('scope').value) $('scope').value = 'active';
 const selectedSprint = board.sprints.find(s => s.id === $('scope').value); const summarySprints = selectedSprint?.state === 'closed' ? [selectedSprint] : active;
 $('sprint-summary').setAttribute('aria-label', selectedSprint?.state === 'closed' ? `Closed sprint: ${selectedSprint.name}` : 'Active sprints');
 $('sprint-summary').replaceChildren(...(view === 'board' ? (summarySprints.length ? summarySprints.map(sprintPanel) : [el('p', 'No active sprint. Use Sprint planning to create and start one, or keep a continuous Kanban flow.', 'empty')]) : []));
 $('scope-label').hidden = view !== 'board'; $('label-filter').hidden = view === 'sprints' || view === 'history'; $('search-filter').hidden = view === 'sprints' || view === 'history'; document.querySelector('.toolbar').hidden = ['history', 'projects', 'labels', 'members'].includes(view);
 renderContent();
}
function filteredItems() {
 const query = $('search').value.toLowerCase(); const scope = $('scope').value; const sprint = board.sprints.find(s => s.id === scope);
 return board.items.filter(i => {
  if (view === 'archive') { if (!i.archived) return false; } else if (i.archived && sprint?.state !== 'closed') return false;
  if (view !== 'archive') { if (scope === 'active' && !activeSprints().some(s => i.sprint_ids.includes(s.id))) return false; if (scope === 'backlog' && (i.sprint_ids.length || done(i))) return false; if (sprint && !scopeItems(sprint).some(v => v.id === i.id)) return false; }
  const project = $('project').value; if (project === 'none' && i.project_id) return false; if (project !== 'all' && project !== 'none' && i.project_id !== project) return false;
  const assignee = $('assignee').value; if (assignee === 'none' && i.assignee) return false; if (assignee !== 'all' && assignee !== 'none' && i.assignee !== assignee) return false;
  const label = $('label').value; if (label === 'none' && i.labels.length) return false; if (label !== 'all' && label !== 'none' && !i.labels.includes(label)) return false;
  return `${i.title} ${i.description} ${i.labels.join(' ')} ${i.assignee} ${memberName(i.assignee)} ${projectName(i.project_id)}`.toLowerCase().includes(query);
 });
}
function card(item, peers) {
 const c = el('article', undefined, 'card'); const top = el('div', undefined, 'card-top'); top.append(button(item.title, () => editItem(item), 'card-title'));
 c.dataset.item = item.id;
 if (!item.archived) {
  makeDraggable(c, 'card', item.id, item.title);
  dropZone(c, 'card', (id, after) => ({kind: 'item.move', target: id, destination: item.column_id, before: after ? peers[peers.findIndex(p => p.id === item.id) + 1]?.id || '' : item.id}));
 }
 const meta = el('div', undefined, 'card-meta'); meta.append(el('small', projectName(item.project_id), 'card-project'), assigneeView(item.assignee));
 c.append(top, meta);
 const sprintTags = el('div', undefined, 'tags'); item.sprint_ids.forEach(id => sprintTags.append(el('span', board.sprints.find(s => s.id === id)?.name || id, 'badge'))); c.append(sprintTags);
 const tags = el('div', undefined, 'tags'); item.labels.forEach(l => tags.append(labelBadge(l))); if (blocked(item)) tags.append(el('span', 'Blocked by dependency', 'badge warning')); if (item.archived) tags.append(el('span', 'Archived', 'badge')); c.append(tags);
 if (item.archived) {
  const controls = el('div', undefined, 'card-controls');
  controls.append(writeButton('Restore item', () => quick({ kind: 'item.restore', target: item.id })));
  c.append(controls);
 }
 const links = board.links.filter(l => l.items.includes(item.id));
 if (links.length) {
  const linkList = el('div', undefined, 'card-links'); linkList.setAttribute('aria-label', 'GitLab links'); links.forEach(link => linkList.append(cardLinkView(link)));
  const details = button('Details', () => showLinks(item), 'card-link-details'); details.setAttribute('aria-label', `View GitLab details · ${links.length}`); details.title = 'Show linked GitLab observations'; linkList.append(details); c.append(linkList);
 }
 return c;
}
function currentBurndownKey(sprintID) { return [board?.workspace.revision || 0, sprintID, $('project').value, $('assignee').value].join('|'); }
function selectedFilterText(id) { return $(id).selectedOptions[0]?.textContent || 'All'; }
function svgNode(tag, attributes = {}) { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value)); return node; }
function burndownSegments(points, key, x, y) {
 const segments = []; let segment = [];
 const flush = () => { if (segment.length > 1) segments.push(segment.join(' ')); segment = []; };
 points.forEach((point, index) => { if (!Number.isFinite(point[key])) { flush(); return; } segment.push(`${x(index)},${y(point[key])}`); }); flush(); return segments;
}
function burndownDateLabel(date) { const value = new Date(`${date}T00:00:00Z`); return Number.isNaN(value.getTime()) ? date : value.toLocaleDateString(undefined, {month:'short', day:'numeric', timeZone:'UTC'}); }
function burndownSVG(data) {
 const width = 760, height = 220, left = 48, right = 20, top = 16, bottom = 36, plotWidth = width - left - right, plotHeight = height - top - bottom, points = data.points;
 const values = points.flatMap(point => [point.scope, point.remaining]).filter(Number.isFinite); const maximum = Math.max(1, ...values);
 const x = index => points.length > 1 ? left + index / (points.length - 1) * plotWidth : left + plotWidth / 2;
 const y = value => top + (maximum - value) / maximum * plotHeight;
 const svg = svgNode('svg', {viewBox:`0 0 ${width} ${height}`, role:'img', 'aria-label':`Burn down for ${data.sprint.name}`, class:'burndown-svg'});
 const title = svgNode('title'); title.textContent = `Burn down for ${data.sprint.name}`; svg.append(title);
 [...new Set(Array.from({length:5}, (_, index) => Math.round(maximum * (1 - index / 4))))].forEach(value => { const line = svgNode('line', {class:'burndown-grid', x1:left, x2:width-right, y1:y(value), y2:y(value)}); svg.append(line); const label = svgNode('text', {class:'burndown-axis-label', x:left-8, y:y(value)+4, 'text-anchor':'end'}); label.textContent = String(value); svg.append(label); });
 const first = points.findIndex(point => Number.isFinite(point.remaining));
 if (first >= 0) { const idealStart = Number.isFinite(points[first].scope) ? points[first].scope : points[first].remaining; svg.append(svgNode('line', {class:'burndown-ideal', x1:x(first), x2:x(points.length-1), y1:y(idealStart), y2:y(0)})); }
 burndownSegments(points, 'scope', x, y).forEach(segment => svg.append(svgNode('polyline', {class:'burndown-scope', points:segment})));
 burndownSegments(points, 'remaining', x, y).forEach(segment => svg.append(svgNode('polyline', {class:'burndown-actual', points:segment})));
 points.forEach((point, index) => { if (!Number.isFinite(point.remaining)) return; const circle = svgNode('circle', {class:'burndown-point', cx:x(index), cy:y(point.remaining), r:3}); const label = svgNode('title'); label.textContent = `${burndownDateLabel(point.date)} · ${point.remaining} remaining · ${point.scope} in scope`; circle.append(label); svg.append(circle); });
 [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].forEach(index => { if (index < 0 || !points[index]) return; const label = svgNode('text', {class:'burndown-axis-label', x:x(index), y:height-16, 'text-anchor':index === 0 ? 'start' : index === points.length-1 ? 'end' : 'middle'}); label.textContent = burndownDateLabel(points[index].date); svg.append(label); });
 return svg;
}
function burndownLegendItem(className, text) { const item = el('span', undefined, 'burndown-legend-item'); item.append(el('span', undefined, `burndown-swatch ${className}`), el('span', text)); return item; }
function burndownTable(data) {
 const details = el('details', undefined, 'burndown-data'); details.append(el('summary', 'View daily values')); const scroll = el('div', undefined, 'burndown-table-scroll'); const table = el('table'); table.append(el('caption', 'Daily native work-item counts')); const head = el('thead'); const heading = el('tr'); const metric = el('th', 'Metric'); metric.scope = 'col'; heading.append(metric); data.points.forEach(point => { const date = el('th', burndownDateLabel(point.date)); date.scope = 'col'; heading.append(date); }); head.append(heading); table.append(head); const body = el('tbody'); [['In scope', 'scope'], ['Remaining', 'remaining']].forEach(([label, key]) => { const row = el('tr'); const metric = el('th', label); metric.scope = 'row'; row.append(metric); data.points.forEach(point => row.append(el('td', point[key] == null ? '—' : String(point[key])))); body.append(row); }); table.append(body); scroll.append(table); details.append(scroll); return details;
}
function latestBurndownPoint(points, key) { return [...points].reverse().find(point => Number.isFinite(point[key])); }
function firstBurndownPoint(points, key) { return points.find(point => Number.isFinite(point[key])); }
function renderBurndown(sprint) {
 const panel = el('section', undefined, 'burndown-panel'); panel.id = `burndown-${sprint.id}`; const headingID = `burndown-heading-${sprint.id}`; panel.setAttribute('aria-labelledby', headingID); const heading = el('div', undefined, 'section-head burndown-head'); const intro = el('div'); const title = el('h3', 'Remaining work'); title.id = headingID; const filterCondition = el('div', undefined, 'burndown-filter-condition'); filterCondition.append(el('p', `Project: ${selectedFilterText('project')}`, 'muted'), el('p', `Assignee: ${selectedFilterText('assignee')}`, 'muted')); intro.append(title, filterCondition); heading.append(intro); const context = el('div', undefined, 'burndown-context'); context.append(heading);
 const key = currentBurndownKey(sprint.id); const data = burndownData.get(key); const error = burndownErrors.get(key);
 if (error) { const retry = button('Retry burn down', () => requestBurndown(sprint.id, true)); retry.disabled = busy || loading; const message = el('p', error, 'error'); message.setAttribute('role', 'alert'); panel.append(context, message, retry); return panel; }
 if (!data) { panel.append(context, el('p', 'Loading native planning history…', 'empty')); requestBurndown(sprint.id); return panel; }
 if (!data.history_available) { panel.append(context, el('p', data.warning, 'empty')); return panel; }
 const available = data.points.some(point => Number.isFinite(point.remaining));
 if (!available) { panel.append(context, el('p', data.warning || 'No matching work is available for this sprint and filter.', 'empty')); return panel; }
 const first = firstBurndownPoint(data.points, 'remaining'); const latest = latestBurndownPoint(data.points, 'remaining'); const stats = el('div', undefined, 'metrics burndown-metrics'); [[firstBurndownPoint(data.points, 'scope')?.scope ?? first.remaining, 'Starting scope'], [latest.remaining, 'Remaining'], [latest.scope, 'Ending scope']].forEach(([value, label]) => { const metric = el('span', undefined, 'metric'); metric.append(el('strong', String(value)), el('span', label)); stats.append(metric); }); context.append(stats);
 const note = el('p', data.warning, 'help burndown-note'); context.append(note);
 const figure = el('figure', undefined, 'burndown-figure'); figure.append(burndownSVG(data)); const legend = el('div', undefined, 'burndown-legend'); legend.append(burndownLegendItem('actual', 'Remaining'), burndownLegendItem('ideal', 'Ideal'), burndownLegendItem('scope', 'Scope')); figure.append(legend); const row = el('div', undefined, 'burndown-chart-row'); row.append(context, figure); panel.append(row, burndownTable(data)); return panel;
}
async function requestBurndown(sprintID, force = false) {
 if (!board || !burndownExpanded.has(sprintID) || loading) return;
 const key = currentBurndownKey(sprintID); if (burndownRequests.has(key)) return; if (!force && (burndownData.has(key) || burndownErrors.has(key))) return;
 if (force) { burndownData.delete(key); burndownErrors.delete(key); }
 const generation = burndownGeneration; const currentBoard = board, currentRoot = root; const token = {}; burndownRequests.set(key, token); $('content').setAttribute('aria-busy', 'true');
 try { const query = new URLSearchParams({sprint:sprintID, project:$('project').value, assignee:$('assignee').value}); const next = await api(currentRoot + '/burndown?' + query); if (generation !== burndownGeneration || board !== currentBoard || root !== currentRoot) return; if (!next || !Array.isArray(next.points) || !next.sprint) throw new Error('Burn-down data is invalid. Refresh to retry.'); if (next.revision !== currentBoard.workspace.revision) throw new Error('Planning changed while loading. Refresh to review.'); burndownData.set(key, next); burndownErrors.delete(key); }
 catch (e) { if (generation !== burndownGeneration || board !== currentBoard || root !== currentRoot) return; burndownErrors.set(key, e.message); }
 finally { if (burndownRequests.get(key) === token) burndownRequests.delete(key); if (generation !== burndownGeneration || board !== currentBoard || root !== currentRoot) return; if (!burndownRequests.size) $('content').setAttribute('aria-busy', 'false'); if (view === 'board' || view === 'sprints') render(); }
}
function renderContent() {
 if (!board) return; const content = $('content'); content.replaceChildren();
 if (view === 'projects') { renderProjects(content); return; }
 if (view === 'labels') { renderLabels(content); return; }
 if (view === 'members') { renderMembers(content); return; }
 if (view === 'sprints') {
  $('count').textContent = '';
  const head = el('div', undefined, 'section-head'); head.append(el('h2', 'Goals, scope, and deliberate carry-over'), writeButton('＋ New sprint', () => editSprint(), 'primary')); content.append(head);
  const list = el('div', undefined, 'sprints'); board.sprints.forEach(s => list.append(sprintPanel(s))); if (!board.sprints.length) list.append(el('p', 'No sprints yet. Create a goal and time box, then add work from the backlog.', 'empty')); content.append(list); return;
 }
 if (view === 'history') { renderHistory(content); return; }
 const items = filteredItems(); $('count').textContent = `${items.length} items · workspace revision ${board.workspace.revision}`;
 if (view === 'board') { const grid = el('div', undefined, 'board'); for (const col of board.columns) { const section = el('section', undefined, 'column'); section.setAttribute('aria-label', col.name); const head = el('div', undefined, 'column-head'); const peers = items.filter(i => i.column_id === col.id); const total = board.items.filter(i => !i.archived && i.column_id === col.id).length; head.append(el('h3', col.name), el('small', `${peers.length} shown · ${col.wip ? `${total}/${col.wip} WIP` : 'No limit'}`)); makeDraggable(head, 'list', col.id, col.name); section.dataset.column = col.id; dropZone(section, 'card', id => ({kind: 'item.move', target: id, destination: col.id}), 'end'); dropZone(section, 'list', (id, after) => ({kind: 'column.rank', target: id, before: after ? board.columns[board.columns.findIndex(c => c.id === col.id) + 1]?.id || '' : col.id}), 'x'); section.append(head); appendCards(section, peers); if (!peers.length) section.append(el('p', 'No work here', 'empty')); grid.append(section); } content.append(grid); }
 else { const list = el('div', undefined, 'list'); appendCards(list, items); if (!items.length) list.append(el('p', view === 'board' && $('scope').value === 'backlog' ? 'Backlog is clear. Create work without a sprint to plan what comes next.' : 'No matching work.', 'empty')); content.append(list); }
}
function appendCards(parent, items) { items.forEach(i => parent.append(card(i, items))); }
async function loadHistory(reset = false) { const events = await api(root + '/history' + (!reset && historyBefore ? `?before=${historyBefore}` : '')); history = reset ? events : [...history, ...events]; historyBefore = events.at(-1)?.id || 0; historyMore = events.length === 50; }
function renderHistory(content) {
 if (!history.length) content.append(el('p', 'No planning changes yet.', 'empty'));
 history.forEach(e => { const row = el('article', undefined, 'history-row'); row.append(el('strong', e.action.replaceAll('.', ' · ')), el('p', `${e.actor} · ${new Date(e.at).toLocaleString()} · ${e.legacy_project_id ? 'legacy project' : 'workspace'} revision ${e.revision}`, 'muted')); if (e.target) row.append(el('small', `Target ${e.target}`, 'card-id')); if (e.reason) row.append(el('p', e.reason)); content.append(row); });
 if (historyMore) content.append(button('Load older changes', async () => { try { await loadHistory(); renderContent(); } catch (e) { notice(e.message, true); } }));
}
function field(parent, name, title, value = '', type = 'text', entries) {
 const label = el('label', title); const input = el(entries ? 'select' : type === 'textarea' ? 'textarea' : 'input'); input.name = name;
 if (entries) options(input, entries, value); else { if (type !== 'textarea') input.type = type; input.value = value; }
 label.append(input); parent.append(label); return input;
}
function markdownURL(value) {
 const raw = String(value || '').trim(); if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return '';
 try { const url = new URL(raw, location.href); if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return ''; return url.href; } catch { return ''; }
}
function markdownEscaped(value) { return value === String.fromCharCode(92) || '`*_[]~'.includes(value); }
function appendMarkdownInline(parent, source) {
 let i = 0;
 while (i < source.length) {
  if (source[i] === String.fromCharCode(92) && i + 1 < source.length && markdownEscaped(source[i + 1])) { parent.append(document.createTextNode(source[i + 1])); i += 2; continue; }
  if (source[i] === '`') {
   const match = /^`+/.exec(source.slice(i)); const marker = match?.[0]; const end = marker ? source.indexOf(marker, i + marker.length) : -1;
   if (marker && end > i + marker.length) { parent.append(el('code', source.slice(i + marker.length, end), 'markdown-inline-code')); i = end + marker.length; continue; }
  }
  if (source.startsWith('![', i)) { parent.append(document.createTextNode('![')); i += 2; continue; }
  const link = /^([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^"\n]*["'])?\)/.exec(source.slice(i).startsWith('[') ? source.slice(i).slice(1) : '');
  if (source[i] === '[' && link) {
   const whole = '[' + link[0]; const href = markdownURL(link[2]);
   if (href) { const anchor = el('a'); anchor.href = href; if (new URL(href, location.href).origin !== location.origin) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; } appendMarkdownInline(anchor, link[1]); parent.append(anchor); } else parent.append(document.createTextNode(whole));
   i += whole.length; continue;
  }
  const auto = /^<((?:https?|mailto):[^<>\s]+)>/.exec(source.slice(i));
  if (auto) {
   const href = markdownURL(auto[1]); if (href) { const anchor = el('a', auto[1]); anchor.href = href; if (new URL(href, location.href).origin !== location.origin) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; } parent.append(anchor); } else parent.append(document.createTextNode(auto[0]));
   i += auto[0].length; continue;
  }
  let formatted = false;
  for (const [marker, tag] of [['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['*', 'em'], ['_', 'em']]) {
   if (!source.startsWith(marker, i)) continue;
   if ((marker === '*' || marker === '_') && /\w/.test(source[i - 1] || '') && /\w/.test(source[i + marker.length] || '')) continue;
   const end = source.indexOf(marker, i + marker.length); if (end <= i + marker.length) continue;
   const node = el(tag); appendMarkdownInline(node, source.slice(i + marker.length, end)); parent.append(node); i = end + marker.length; formatted = true; break;
  }
  if (formatted) continue;
  parent.append(document.createTextNode(source[i])); i++;
 }
}
function markdownBlockStart(line) { return /^\s{0,3}(?:#{1,6}\s|`{3,}|~{3,}|>\s?|[-+*]\s+|\d+[.)]\s+|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line); }
function markdownTableCells(line) {
 const value = line.trim(); if (!value.includes('|')) return null; const withoutStart = value.startsWith('|') ? value.slice(1) : value; const source = withoutStart.endsWith('|') ? withoutStart.slice(0, -1) : withoutStart; const cells = []; let cell = ''; let escaped = false;
 for (const character of source) { if (character === '|' && !escaped) { cells.push(cell.trim()); cell = ''; } else cell += character; escaped = character === '\\' && !escaped; if (character !== '\\') escaped = false; }
 cells.push(cell.trim()); return cells;
}
function renderMarkdown(parent, source) {
 parent.replaceChildren(); const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n'); let index = 0;
 while (index < lines.length) {
  if (!lines[index].trim()) { index++; continue; }
  const tableHeader = markdownTableCells(lines[index]); const tableRule = index + 1 < lines.length ? markdownTableCells(lines[index + 1]) : null;
  if (tableHeader?.length && tableRule?.length === tableHeader.length && tableRule.every(cell => /^:?-{3,}:?$/.test(cell))) {
   const table = el('table', undefined, 'markdown-table'); const alignments = tableRule.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.startsWith(':') ? 'left' : cell.endsWith(':') ? 'right' : '');
   const row = (tag, cells) => { const result = el('tr'); cells.forEach((cell, cellIndex) => { const node = el(tag); if (alignments[cellIndex]) node.style.textAlign = alignments[cellIndex]; appendMarkdownInline(node, cell); result.append(node); }); return result; };
   const head = el('thead'); head.append(row('th', tableHeader)); const body = el('tbody'); index += 2;
   while (index < lines.length && lines[index].trim()) { const cells = markdownTableCells(lines[index]); if (!cells || cells.length !== tableHeader.length) break; body.append(row('td', cells)); index++; }
   table.append(head, body); parent.append(table); continue;
  }
  const fence = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/.exec(lines[index]);
  if (fence) {
   const marker = fence[1]; const code = []; index++;
   while (index < lines.length) { const trimmed = lines[index].trim(); if (trimmed.length >= marker.length && [...trimmed].every(character => character === marker[0])) { index++; break; } code.push(lines[index++]); }
   const pre = el('pre', undefined, 'markdown-code-block'); pre.append(el('code', code.join('\n'))); parent.append(pre); continue;
  }
  const heading = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(lines[index]);
  if (heading) { const node = el('h' + heading[1].length); appendMarkdownInline(node, heading[2]); parent.append(node); index++; continue; }
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[index])) { parent.append(el('hr', undefined, 'markdown-rule')); index++; continue; }
  const quote = /^\s{0,3}>\s?(.*)$/.exec(lines[index]);
  if (quote) {
   const quoteLines = [];
   while (index < lines.length) { const line = /^\s{0,3}>\s?(.*)$/.exec(lines[index]); if (!line) break; quoteLines.push(line[1]); index++; }
   const blockquote = el('blockquote'); renderMarkdown(blockquote, quoteLines.join('\n')); parent.append(blockquote); continue;
  }
  const unordered = /^\s{0,3}[-+*]\s+(.+)$/.exec(lines[index]); const ordered = /^\s{0,3}\d+[.)]\s+(.+)$/.exec(lines[index]);
  if (unordered || ordered) {
   const list = el(ordered ? 'ol' : 'ul'); const pattern = ordered ? /^\s{0,3}\d+[.)]\s+(.+)$/ : /^\s{0,3}[-+*]\s+(.+)$/;
   while (index < lines.length) { const item = pattern.exec(lines[index]); if (!item) break; const listItem = el('li'); const task = /^\[([ xX])\]\s+(.+)$/.exec(item[1]); if (task) { const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = task[1].toLowerCase() === 'x'; checkbox.disabled = true; checkbox.tabIndex = -1; checkbox.setAttribute('aria-label', checkbox.checked ? 'Completed task' : 'Incomplete task'); listItem.className = 'markdown-task'; listItem.append(checkbox); appendMarkdownInline(listItem, task[2]); } else appendMarkdownInline(listItem, item[1]); list.append(listItem); index++; }
   parent.append(list); continue;
  }
  const paragraphLines = [lines[index++]];
  while (index < lines.length && lines[index].trim() && !markdownBlockStart(lines[index])) paragraphLines.push(lines[index++]);
  const paragraph = el('p'); paragraphLines.forEach((line, lineIndex) => { if (lineIndex) paragraph.append(el('br')); appendMarkdownInline(paragraph, line); }); parent.append(paragraph);
 }
}
function markdownEditor(parent, name, title, value = '', maxLength = 4000, readOnly = false, previewByDefault = false) {
 const group = el('div', undefined, 'markdown-field'); const inputID = 'markdown-' + requestKey(); const label = el('label', undefined, 'markdown-label'); label.htmlFor = inputID; label.append(el('span', title)); group.append(label);
 if (readOnly) { const preview = el('div', undefined, 'markdown-preview'); renderMarkdown(preview, value); if (!String(value || '').trim()) preview.append(el('p', 'No content.', 'help')); group.append(preview); parent.append(group); return {input: null, refresh: () => {}}; }
 const editor = el('div', undefined, 'markdown-editor'); const toolbar = el('div', undefined, 'markdown-toolbar'); const subject = title === 'Description' ? 'description' : 'comment'; let previewing = previewByDefault;
 const modeButton = button(previewByDefault ? 'Edit' : 'Preview', () => setMode(!previewing), 'markdown-mode'); modeButton.setAttribute('aria-label', `Preview ${subject}`); modeButton.title = `Preview ${subject}`; toolbar.append(modeButton);
 const input = el('textarea'); input.id = inputID; input.name = name; input.value = value || ''; input.maxLength = maxLength; input.placeholder = 'Write Markdown…'; input.spellcheck = true; input.dataset.markdownControl = 'true'; const preview = el('div', undefined, 'markdown-preview'); preview.hidden = true; preview.tabIndex = 0;
 function replaceSelection(transform, placeholder = 'text') { const start = input.selectionStart ?? input.value.length; const end = input.selectionEnd ?? start; const selected = input.value.slice(start, end) || placeholder; input.setRangeText(transform(selected), start, end, 'select'); input.dispatchEvent(new Event('input', {bubbles: true})); input.focus(); }
 const tools = [], dividers = []; function addDivider() { const divider = el('span', undefined, 'markdown-divider'); divider.setAttribute('role', 'separator'); divider.setAttribute('aria-orientation', 'vertical'); divider.setAttribute('aria-hidden', 'true'); dividers.push(divider); toolbar.append(divider); }
 function addTool(label, icon, transform, placeholder) { const tool = button(icon, () => replaceSelection(transform, placeholder), 'markdown-tool'); tool.setAttribute('aria-label', label); tool.title = label; tools.push(tool); toolbar.append(tool); }
 const prefixLines = (text, prefix) => text.split('\n').map(line => prefix + line).join('\n');
 addDivider(); addTool('Bold', 'B', text => `**${text}**`, 'bold text'); addTool('Italic', 'I', text => `_${text}_`, 'italic text'); addTool('Strikethrough', 'S', text => `~~${text}~~`, 'struck text');
 addDivider(); addTool('Inline code', '<>', text => '`' + text + '`', 'code'); addTool('Code block', '▣', text => '```\n' + text + '\n```', 'code block'); addTool('Link', '↗', text => `[${text}](https://example.com)`, 'link text');
 addDivider(); addTool('Heading', 'H', text => prefixLines(text, '## '), 'heading'); addTool('Insert table', '▦', text => '\n\n| ' + text + ' | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n\n', 'Header 1');
 addDivider(); addTool('Bulleted list', '•', text => prefixLines(text, '- '), 'list item'); addTool('Numbered list', '1.', text => text.split('\n').map((line, index) => `${index + 1}. ${line}`).join('\n'), 'list item'); addTool('Task list', '☑', text => prefixLines(text, '- [ ] '), 'task item');
 addDivider(); addTool('Quote', '❝', text => prefixLines(text, '> '), 'quoted text'); addTool('Horizontal rule', '—', () => '---', '');
 function renderPreview() { renderMarkdown(preview, input.value); if (!input.value.trim()) preview.append(el('p', 'Nothing to preview yet.', 'help')); }
 function updateModeButton() { const label = previewing ? `Edit ${subject}` : `Preview ${subject}`; modeButton.textContent = previewing ? 'Edit' : 'Preview'; modeButton.setAttribute('aria-label', label); modeButton.title = label; }
 function setMode(next) { previewing = next; updateModeButton(); tools.concat(dividers).forEach(control => { control.hidden = next; }); input.hidden = next; preview.hidden = !next; if (next) renderPreview(); else input.focus(); }
 const refresh = () => { if (previewing) renderPreview(); }; input.addEventListener('input', refresh); input.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return; const key = event.key.toLowerCase();
  if (key === 'b') { event.preventDefault(); replaceSelection(text => `**${text}**`, 'bold text'); }
  else if (key === 'i') { event.preventDefault(); replaceSelection(text => `_${text}_`, 'italic text'); }
  else if (key === 'k') { event.preventDefault(); replaceSelection(text => `[${text}](https://example.com)`, 'link text'); }
  else if (event.shiftKey && key === 'x') { event.preventDefault(); replaceSelection(text => `~~${text}~~`, 'struck text'); }
 }); editor.append(toolbar, input, preview); group.append(editor); parent.append(group); if (previewByDefault) setMode(true); else updateModeButton(); return {input, refresh};
}
function helpPopover(text, name = 'Help') {
 const wrapper = el('span', undefined, 'help-popover'); const trigger = button('?', () => toggle(), 'help-trigger'); const content = el('span', text, 'help-popover-content');
 content.id = `help-${requestKey()}`; content.hidden = true; content.setAttribute('role', 'tooltip'); trigger.setAttribute('aria-label', `Help: ${name}`); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', content.id); trigger.setAttribute('aria-describedby', content.id);
 let outside;
 function close(focus = false) { if (content.hidden) return; content.hidden = true; trigger.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outside); if (focus) trigger.focus(); }
 function open() { content.hidden = false; trigger.setAttribute('aria-expanded', 'true'); outside = e => { if (!wrapper.contains(e.target)) close(); }; document.addEventListener('click', outside); }
 function toggle() { if (content.hidden) open(); else close(true); }
 trigger.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(true); } }); wrapper.append(trigger, content); return wrapper;
}
function multiSelect(parent, name, title, entries, selected = [], decorate, helpText, settings = {}) {
 const single = settings.single === true; const onChange = settings.onChange; const onFilter = settings.onFilter; const onOpen = settings.onOpen;
 const group = el('div', undefined, 'multi-select-field'); const label = el('span', title, 'multi-select-label');
 const heading = el('span', undefined, 'multi-select-heading'); heading.append(label); if (helpText) heading.append(helpPopover(helpText, title));
 const root = el('div', undefined, 'multi-select'); root.setAttribute('role', 'group'); root.setAttribute('aria-label', title);
 const values = el('div', undefined, 'multi-select-values'); const menu = el('div', undefined, 'multi-select-menu');
 const filter = el('input'); filter.type = 'search'; filter.className = 'multi-select-filter'; filter.placeholder = `Filter ${title.toLowerCase()}…`; filter.setAttribute('aria-label', `Filter ${title}`);
 const list = el('div', undefined, 'multi-select-options'); const status = el('p', '', 'multi-select-empty'); status.hidden = true; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); const empty = el('p', 'No matches.', 'multi-select-empty'); menu.append(filter, status, list, empty); menu.hidden = true;
 menu.id = `multi-select-${requestKey()}`; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', `${title} options`);
 const edit = button('Edit', toggle, 'multi-select-edit'); edit.dataset.multiEdit = 'true'; edit.setAttribute('aria-label', `Edit ${title}`); edit.setAttribute('aria-haspopup', 'true'); edit.setAttribute('aria-expanded', 'false'); edit.setAttribute('aria-controls', menu.id);
 const header = el('div', undefined, 'multi-select-header'); header.append(heading, edit); header.addEventListener('click', event => { if (!menu.hidden && !edit.contains(event.target)) close(); });
 let choices = [], controls, editing = false;
 function currentValues() { return choices.filter(choice => choice.input.checked).map(choice => choice.value); }
 function replaceEntries(nextEntries, selectedValues = []) {
  let selectedSet = new Set(selectedValues.map(String)); if (single && selectedValues.length > 1) selectedSet = new Set([String(selectedValues[0])]);
  const seen = new Set(); list.replaceChildren(); choices = [];
  nextEntries.forEach(([rawValue, rawText]) => {
   const value = String(rawValue); if (seen.has(value)) return; seen.add(value); const text = String(rawText);
   const option = el('label', undefined, 'multi-select-option'); const input = el('input'); input.type = 'checkbox'; input.name = name; input.value = value; input.checked = selectedSet.has(value); input.setAttribute('aria-label', text);
   option.append(input, el('span', text)); list.append(option); const choice = {value, text, input, option}; choices.push(choice);
   input.addEventListener('change', () => { if (single && input.checked) choices.forEach(other => { if (other.input !== input) other.input.checked = false; }); render(); if (onChange) onChange(currentValues()); });
  });
  render();
 }
 function setEntries(nextEntries, selectedValues) { replaceEntries(nextEntries, selectedValues === undefined ? currentValues() : selectedValues); }
 function selectValue(value) {
  if (!single) return false;
  const choice = choices.find(candidate => candidate.value === String(value)); if (!choice) return false;
  choices.forEach(candidate => { candidate.input.checked = candidate === choice; }); render(); if (onChange) onChange(currentValues()); return true;
 }
 function setStatus(text) { status.textContent = text || ''; status.hidden = !text; render(); }
 function invoke(handler, query) {
  if (!handler) return;
  try { Promise.resolve(handler(query, controls)).catch(error => setStatus(error.message || String(error))); } catch (error) { setStatus(error.message || String(error)); }
 }
 let outside;
 function close(focus = false) { if (menu.hidden) return; menu.hidden = true; editing = false; edit.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outside); render(); if (focus) edit.focus(); }
 function open() { editing = true; menu.hidden = false; edit.setAttribute('aria-expanded', 'true'); outside = e => { if (!group.contains(e.target)) close(); }; document.addEventListener('click', outside); render(); filter.focus(); filter.select(); invoke(onOpen, filter.value.trim()); }
 function toggle() { if (menu.hidden) open(); else close(true); }
 function render() {
  values.replaceChildren(); const chosen = choices.filter(choice => choice.input.checked);
  if (!chosen.length) values.append(el('span', 'None selected', 'multi-select-empty'));
  chosen.forEach(choice => { const chip = el('span', undefined, 'multi-select-chip'); chip.append(el('span', choice.text)); if (decorate) decorate(chip, choice.value, choice.text); const remove = button('×', () => { choice.input.checked = false; render(); if (onChange) onChange(currentValues()); }, 'multi-select-remove'); remove.dataset.multiRemove = 'true'; remove.hidden = !editing; remove.setAttribute('aria-label', `Remove ${choice.text}`); chip.append(remove); values.append(chip); });
  const query = filter.value.trim().toLowerCase(); let visible = 0;
  choices.forEach(choice => { const match = !query || choice.text.toLowerCase().includes(query); choice.option.hidden = !match; if (match) visible++; }); empty.hidden = visible > 0 || !status.hidden;
 }
 controls = {root, group, header, edit, filter, close, isOpen: () => !menu.hidden, setEntries, setStatus, select: selectValue, selected: currentValues};
 filter.addEventListener('input', () => { render(); invoke(onFilter, filter.value.trim()); }); menu.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(true); } });
 root.append(values, menu); group.append(header, root); parent.append(group); replaceEntries(entries, selected); return controls;
}
function labelColorPicker(parent, value) {
 const palette = el('fieldset', undefined, 'label-palette'); palette.append(el('legend', 'Label color'));
 const selected = String(value || '').trim().toLowerCase();
 LABEL_PALETTE.forEach(color => { const input = el('input'); input.type = 'radio'; input.name = 'color'; input.value = color; input.checked = color === selected; input.setAttribute('aria-label', color); input.title = color; input.style.backgroundColor = color; palette.append(input); });
 parent.append(palette); return palette;
}
let editorReturn;
function closeEditor() {
 if (busy) return;
 const returnTo = editorReturn; editorReturn = undefined; $('editor').close(); if (returnTo) returnTo();
}
function openEditor(title, build, submit, readOnly = false, afterSave, afterClose) {
 editorReturn = afterClose;
 $('editor-title').textContent = title; $('editor-form').classList.toggle('item-editor-form', ['Work item', 'Create work item'].includes(title)); $('editor-form').querySelectorAll('[data-item-footer]').forEach(e => e.remove()); $('fields').replaceChildren(); $('form-error').textContent = ''; $('save').textContent = 'Save changes'; $('save').hidden = readOnly; $('save').disabled = false;
 const revision = board.workspace.revision; let pending, key; build($('fields'));
 if (readOnly) {
  $('fields').querySelectorAll('input:not([data-comment-control]),textarea:not([data-comment-control]),select:not([data-comment-control])').forEach(e => { e.disabled = true; });
  $('fields').querySelectorAll('[data-multi-edit],[data-multi-remove]').forEach(e => { e.disabled = true; });
 }
 $('editor-form').onsubmit = async e => {
  e.preventDefault(); if (readOnly || busy) return; $('form-error').textContent = ''; $('save').disabled = true; $('cancel').disabled = true; $('dismiss').disabled = true;
  try {
   const command = { revision, ...submit(new FormData($('editor-form'))) };
   const serialized = JSON.stringify(command); if (pending !== serialized) { key = requestKey(); pending = serialized; }
   await change(command, key); if (afterSave) await afterSave(command); closeEditor();
  } catch (err) { $('form-error').textContent = `${err.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`; }
  finally { $('save').disabled = false; $('cancel').disabled = false; $('dismiss').disabled = false; }
 };
 $('editor').showModal();
}
async function showProposals(before = 0) {
 if (!board || busy || loading) return;
 const currentRoot = root;
 try {
  const rows = await api(currentRoot + '/proposals?before=' + before);
  if (root !== currentRoot || busy) return;
  $('editor').close();
  openEditor('Planning proposals', fields => {
   fields.append(el('p', 'Agent output is an unverified suggestion. Importing creates a draft only; a human must review the exact diff before any planning changes.', 'help'));
   fields.append(writeButton('Import proposal or migration JSON', () => importProposal()));
   if (!rows.length) fields.append(el('p', 'No proposals on this page.', 'empty'));
   for (const row of rows) { const card = el('article', undefined, 'setup-row'); card.append(el('strong', row.title), el('p', `${row.state} · Imported by ${row.imported_by} · workspace revision ${row.revision}`, 'muted'), button('Review ' + row.title, () => reviewProposal(row.id))); fields.append(card); }
   if (rows.length === 20) fields.append(button('Older proposals', () => showProposals(rows.at(-1).sequence)));
   if (before) fields.append(button('Newest proposals', () => showProposals()));
  }, () => ({}), true);
 } catch (e) { notice(e.message, true); }
}
function importProposal(document) {
 $('editor').close(); const id = requestKey();
 openEditor('Import proposal draft', fields => {
  fields.append(el('p', 'Paste a version-1 proposal or the document/report from flux import. This saves a draft, not planning changes. Source identity and agent provenance are not verified.', 'help'));
  const input = field(fields, 'document', 'Proposal JSON', document ? JSON.stringify(document, null, 2) : '', 'textarea'); input.required = true; input.maxLength = 60000;
  field(fields, 'reason', 'Import rationale', '', 'textarea').required = true;
 }, data => {
  const parsed = JSON.parse(data.get('document'));
  if (parsed.unresolved?.length) throw new Error('Resolve all import mappings before creating a draft.');
  return {kind:'proposal.import',target:id,proposal:parsed.document || parsed,reason:data.get('reason').trim()};
 });
 $('save').textContent = 'Save draft only';
}
async function reviewProposal(id) {
 const currentRoot = root;
 try {
  const preview = await api(currentRoot + '/proposals/' + encodeURIComponent(id));
  if (root !== currentRoot || busy) return;
  const v = preview.proposal; const canAccept = v.state === 'draft' && !!preview.digest && !preview.problem && writable();
  $('editor').close();
  openEditor('Review planning proposal', fields => {
   fields.append(el('h3', v.document.title, 'proposal-text'), el('p', v.document.rationale, 'proposal-text'), el('p', `Claimed provenance (unverified): ${v.document.provenance}`, 'help proposal-text'), el('p', `Imported by ${v.imported_by} · ${v.state}${v.reviewed_by ? ' · Reviewed by ' + v.reviewed_by : ''}`, 'help'));
   if (v.review_reason) fields.append(el('p', v.review_reason, 'proposal-text'));
   if (preview.problem) fields.append(el('p', preview.problem, 'error'));
   fields.append(el('p', `New imports: ${preview.created || 0} · Already imported, retained unchanged: ${Object.keys(preview.skipped || {}).length}`, 'help'));
   if (Object.keys(preview.workspace_changes || {}).length) fields.append(el('h3', 'Workspace changes'), el('pre', JSON.stringify(preview.workspace_changes, null, 2), 'proposal-data'));
   for (const change of preview.changes || []) { const row = el('section', undefined, 'setup-row'); row.append(el('strong', 'Native item ' + change.id)); for (const [name, values] of Object.entries(change.fields)) { row.append(el('h4', name), el('pre', 'Before: ' + JSON.stringify(values.before, null, 2) + '\nAfter: ' + JSON.stringify(values.after, null, 2), 'proposal-data')); } fields.append(row); }
   const details = el('details'); details.append(el('summary', 'Original document, evidence and skipped sources'), el('pre', JSON.stringify({document:v.document,skipped:preview.skipped}, null, 2), 'proposal-data')); fields.append(details);
   if (v.state === 'draft') {
    fields.append(writeButton('Revise as new draft', () => importProposal(v.document)), writeButton('Reject proposal', () => rejectProposal(v.id)));
   }
   if (canAccept) {
    field(fields, 'reason', 'Approval rationale', '', 'textarea').required = true;
    const consent = field(fields, 'consent', 'I reviewed and approve this exact diff', 'yes', 'checkbox'); consent.required = true; consent.parentElement.classList.add('consent'); consent.parentElement.prepend(consent);
   }
  }, data => {
   if (!data.get('consent')) throw new Error('Explicit approval is required.');
   return {kind:'proposal.accept',target:v.id,revision:v.document.revision,name:preview.digest,reason:data.get('reason').trim()};
  }, !canAccept);
  $('save').textContent = 'Accept exact diff';
 } catch (e) { notice(e.message, true); }
}
async function rejectProposal(id) {
 if (!await refresh()) return;
 $('editor').close();
 openEditor('Reject planning proposal', fields => { field(fields, 'reason', 'Rejection rationale', '', 'textarea').required = true; }, data => ({kind:'proposal.reject',target:id,reason:data.get('reason').trim()}));
 $('save').textContent = 'Reject proposal';
}
function itemEditorDraft() {
 const data = new FormData($('editor-form'));
 return {title:String(data.get('title') || ''), description:String(data.get('description') || ''), column_id:String(data.get('column_id') || ''), project_id:String(data.get('project_id') || ''), assignee:String(data.get('assignee') || ''), sprint_ids:data.getAll('sprint_ids'), labels:data.getAll('labels'), dependencies:data.getAll('dependencies'), link_ids:data.getAll('link_ids')};
}
function resolveGitLabMRURL(value, currentBoard, projects) {
 const raw = String(value || '').trim(); if (!raw) throw new Error('Paste a GitLab merge-request URL first.');
 if (!currentBoard.connector_instance || currentBoard.connector_instance !== currentBoard.integration.instance) throw new Error('GitLab link creation is not configured for this workspace.');
 if (!currentBoard.integration.projects.length) throw new Error('No approved GitLab projects are available for linking.');
 let target, instance, projectPath;
 try { target = new URL(raw); instance = new URL(currentBoard.connector_instance); projectPath = decodeURIComponent(target.pathname); } catch { throw new Error('Enter a valid GitLab merge-request URL.'); }
 if (raw.length > 2048 || /[\r\n]/.test(raw) || target.origin !== instance.origin || target.username || target.password) throw new Error('Use a URL from the configured GitLab instance.');
 const basePath = instance.pathname.replace(/\/+$/, ''); const prefix = basePath ? basePath + '/' : '/'; if (!target.pathname.startsWith(prefix)) throw new Error('That URL is outside the configured GitLab instance.');
 const tail = projectPath.slice(prefix.length); const marker = '/-/merge_requests/'; const markerAt = tail.lastIndexOf(marker); const iid = markerAt < 0 ? '' : tail.slice(markerAt + marker.length); projectPath = markerAt > 0 ? projectPath.slice(prefix.length, prefix.length + markerAt) : '';
 if (markerAt <= 0 || !/^[1-9][0-9]*$/.test(iid) || !Number.isSafeInteger(Number(iid))) throw new Error('Use a canonical GitLab merge-request URL.');
 const approved = new Set(currentBoard.integration.projects.map(String)); const project = projects.find(value => approved.has(String(value.id)) && typeof value.path_with_namespace === 'string' && value.path_with_namespace.trim() === projectPath);
 if (!project) throw new Error('That merge-request project is not in the approved GitLab project catalog.');
 return {project:Number(project.id), kind:'mr', number:Number(iid)};
}
async function attachItemGitLabLink(item, link) {
 const currentBoard = board, currentRoot = root; const draft = itemEditorDraft(); const previous = new Set(currentBoard.links.filter(value => value.items.includes(item.id)).map(value => value.id)); closeEditor();
 try { await change({revision:currentBoard.workspace.revision, kind:'link.attach', target:item.id, link}); }
 catch (error) { if (root === currentRoot && board) { const latest = board.items.find(value => value.id === item.id); if (latest) editItem(latest, draft); notice(error.message, true); } return; }
 if (root !== currentRoot || !board) return; const latest = board.items.find(value => value.id === item.id); if (!latest) return;
 const added = board.links.filter(value => value.items.includes(item.id) && !previous.has(value.id)).map(value => value.id); editItem(latest, {...draft, link_ids:[...new Set([...draft.link_ids, ...added])]});
}
function inlineGitLabPaste(parent, item, readOnly) {
 const currentBoard = board, currentRoot = root; const row = el('div', undefined, 'gitlab-paste-row'); const input = el('input'); input.type = 'text'; input.inputMode = 'url'; input.placeholder = 'Paste GitLab MR URL, then press Enter or click Get'; input.maxLength = 2048; input.setAttribute('aria-label', 'GitLab MR URL'); const get = button('Get', resolve, 'primary'); get.dataset.gitlabWrite = 'true'; get.disabled = readOnly || !gitLabWritable(); row.append(input, get);
 const status = el('p', '', 'help'); status.hidden = true; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); const setStatus = (text, error = false) => { status.textContent = text || ''; status.className = error ? 'error' : 'help'; status.hidden = !text; };
 let pending = false;
 async function resolve() {
  if (pending || get.disabled) return; const raw = input.value.trim(); if (!raw) { setStatus('Paste a GitLab merge-request URL first.', true); input.focus(); return; }
  pending = true; get.disabled = true; setStatus('Resolving GitLab merge request…');
  try { const projects = await loadGitLabProjects(currentRoot); if (!row.isConnected || board !== currentBoard || root !== currentRoot) return; const link = resolveGitLabMRURL(raw, currentBoard, projects); await attachItemGitLabLink(item, link); }
  catch (error) { if (row.isConnected) { setStatus(error.message, true); input.focus(); } }
  finally { pending = false; if (row.isConnected) get.disabled = !gitLabWritable(); }
 }
 input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); resolve(); } }); parent.append(row, status);
}
async function addGitLabLink(item) {
 const currentBoard = board, currentRoot = root;
 const draft = item && $('editor').open ? itemEditorDraft() : undefined;
 closeEditor(); let projects = [], catalogError = '';
 const returnToCard = () => { if (root !== currentRoot || !board) return; const latest = board.items.find(value => value.id === item.id); if (!latest) return; const previous = new Set(currentBoard.links.filter(value => value.items.includes(item.id)).map(value => value.id)); const added = board.links.filter(value => value.items.includes(item.id) && !previous.has(value.id)).map(value => value.id); const returnDraft = draft ? {...draft, link_ids:[...new Set([...draft.link_ids, ...added])]} : undefined; editItem(latest, returnDraft); };
 try { projects = await loadGitLabProjects(currentRoot); } catch (e) { catalogError = e.message; }
 if (board !== currentBoard || root !== currentRoot) return;
 openEditor('Add link', fields => {
  $('editor-title').append(' ', helpPopover('Choose an approved project and use a quick scope or merge-request search. Enter an MR IID only as a final fallback. Flux retrieves the latest pipeline status from the linked MR.', 'GitLab links'));
  let mrPicker, manualMR; let searchTimer; let searchGeneration = 0;
  if (catalogError) {
   const error = el('p', `Could not load the GitLab project list. ${catalogError} Approved project IDs remain available so this link is not blocked by a temporary catalog failure.`, 'error'); error.setAttribute('role', 'alert'); fields.append(error);
  }
  const projectPicker = multiSelect(fields, 'project', 'Approved GitLab project', approvedGitLabProjectEntries(projects), [], undefined, 'Choose one approved project. The project list is provided by the configured GitLab connector and is searchable.', {single:true, onChange: values => {
   searchGeneration++; if (searchTimer) clearTimeout(searchTimer); if (!mrPicker) return;
   mrPicker.filter.value = ''; mrPicker.setEntries([], []); if (manualMR) manualMR.value = ''; mrPicker.setStatus(values.length ? 'Open the merge-request picker to load results.' : 'Select an approved project first.');
  }});
  const scope = field(fields, 'scope', 'Quick scope', 'recent', 'text', [['recent','Recent merge requests'],['assigned_to_me','Assigned to me'],['board_members','Assigned to board members']]);
  const queueMergeRequestSearch = (query, controls) => {
   if (searchTimer) clearTimeout(searchTimer); const generation = ++searchGeneration; const project = projectPicker.selected()[0];
   if (!project) { controls.setEntries([], []); controls.setStatus('Select an approved project first.'); return; }
   controls.setStatus('Searching GitLab…'); searchTimer = setTimeout(async () => {
    try {
     const params = new URLSearchParams({project, scope:scope.value || 'recent', search:query}); const data = await api(currentRoot + '/gitlab/merge-requests?' + params);
     if (generation !== searchGeneration || board !== currentBoard || root !== currentRoot) return;
     if (!validGitLabMergeRequestCatalog(data)) throw new Error('GitLab merge-request results are invalid. Refresh to retry.');
     const selected = controls.selected(); controls.setEntries(mergeRequestEntries(data, selected), selected); controls.setStatus(data.length ? '' : 'No matching merge requests.');
    } catch (e) { if (generation === searchGeneration && board === currentBoard && root === currentRoot) controls.setStatus(e.message); }
   }, 250);
  };
  mrPicker = multiSelect(fields, 'merge_request', 'Merge request', [], [], undefined, 'After trying a quick scope, search by title or IID. Results are ordered by GitLab update time; selecting one stores only its project-scoped IID.', {single:true, onFilter:queueMergeRequestSearch, onOpen:queueMergeRequestSearch, onChange: values => { if (!values.length) return; if (manualMR) manualMR.value = ''; }}); mrPicker.filter.maxLength = 120;
  manualMR = field(fields, 'manual_mr_iid', 'MR IID (optional fallback)', '', 'number'); manualMR.min = 1; manualMR.max = Number.MAX_SAFE_INTEGER; manualMR.step = 1;
  scope.addEventListener('change', () => { const wasOpen = mrPicker.isOpen(); searchGeneration++; if (searchTimer) clearTimeout(searchTimer); mrPicker.filter.value = ''; mrPicker.setEntries([], []); mrPicker.setStatus(projectPicker.selected().length ? 'Open the merge-request picker to load results.' : 'Select an approved project first.'); if (wasOpen) queueMergeRequestSearch('', mrPicker); });
  if (!projects.length && !catalogError && !board.integration.projects.length) fields.append(el('p', 'No approved GitLab projects are available for linking.', 'help'));
 }, data => {
  const rawProject = String(data.get('project') || ''); const selectedMR = String(data.get('merge_request') || ''); const manualIID = String(data.get('manual_mr_iid') || ''); const rawNumber = selectedMR || manualIID;
  if (!/^[1-9][0-9]*$/.test(rawProject) || !Number.isSafeInteger(Number(rawProject))) throw new Error('Choose an approved GitLab project.');
  if (selectedMR && manualIID) throw new Error('Select a merge request or enter its IID manually, not both.');
  if (!/^[1-9][0-9]*$/.test(rawNumber) || !Number.isSafeInteger(Number(rawNumber))) throw new Error('Select a merge request or enter a positive MR IID.');
  return {kind:'link.attach', target:item.id, link:{project:Number(rawProject), kind:'mr', number:Number(rawNumber)}};
 }, false, undefined, returnToCard);
}
async function reconcileItemLinks(itemID, desiredIDs) {
 const desired = new Set(desiredIDs);
 for (const link of board.links.filter(link => link.items.includes(itemID) && !desired.has(link.id))) {
  await change({revision:board.workspace.revision, kind:'link.detach', target:itemID, destination:link.id});
 }
 for (const linkID of desired) {
  if (board.links.some(link => link.id === linkID && link.items.includes(itemID))) continue;
  const link = board.links.find(value => value.id === linkID);
  if (!link) throw new Error('A selected GitLab link is no longer available. Refresh and reopen the card.');
  await change({revision:board.workspace.revision, kind:'link.attach', target:itemID, link:{project:link.project, kind:link.kind, number:link.number}});
 }
}
function commentTime(value) {
 const date = new Date(value); if (Number.isNaN(date.getTime())) return {label:'Unknown time', dateTime:''}; return {label:date.toLocaleString(), dateTime:date.toISOString()};
}
function validComments(data) { return Array.isArray(data) && data.every(comment => comment && Number.isSafeInteger(comment.id) && comment.id > 0 && typeof comment.item_id === 'string' && typeof comment.author === 'string' && comment.author && typeof comment.body === 'string' && comment.body && typeof comment.created_at === 'string' && !Number.isNaN(Date.parse(comment.created_at))); }
function renderCommentList(list, comments) {
 list.replaceChildren(); if (!comments.length) return;
 comments.forEach(comment => {
  const row = el('article', undefined, 'comment'); const info = memberInfo(comment.author); const avatar = el('span', undefined, 'avatar comment-avatar'); avatar.setAttribute('aria-hidden', 'true'); avatar.append(el('span', initials(info.name), 'avatar-fallback'));
  if (info.avatarURL) { const image = el('img'); image.src = info.avatarURL; image.alt = ''; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.onerror = () => image.remove(); avatar.append(image); }
  const content = el('div', undefined, 'comment-content'); const header = el('div', undefined, 'comment-head'); const author = el('strong', info.name); author.title = comment.author; const time = commentTime(comment.created_at); const created = el('time', time.label, 'muted'); if (time.dateTime) created.dateTime = time.dateTime; header.append(author, created); const body = el('div', undefined, 'comment-body'); renderMarkdown(body, comment.body); content.append(header, body); row.append(avatar, content); list.append(row);
 });
}
function renderItemComments(fields, item) {
 const currentBoard = board, currentRoot = root; const section = el('section', undefined, 'item-comments'); const heading = el('div', undefined, 'section-head'); heading.append(el('h3', 'Comments')); const status = el('p', 'Loading comments…', 'help'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); const list = el('div', undefined, 'comment-list'); let commentBusy = false; let commentLoad = 0; let addButton, textarea, refreshCommentPreview;
 const setStatus = (text, error = false) => { status.textContent = text; status.className = error ? 'error' : 'help'; status.setAttribute('role', error ? 'alert' : 'status'); };
 section.append(heading, status, list);
 if (board.role !== 'member' && board.role !== 'admin') section.append(el('p', 'Viewers can read comments; members and admins can add them.', 'help'));
 else {
  const composer = el('div', undefined, 'comment-composer'); const editor = markdownEditor(composer, 'comment_body', 'Add a comment', '', 4000); textarea = editor.input; textarea.dataset.commentControl = 'true'; refreshCommentPreview = editor.refresh; addButton = button('Add comment', addComment, 'primary'); addButton.dataset.commentWrite = 'true'; addButton.disabled = !canComment(); composer.append(addButton); section.append(composer);
 }
 fields.append(section);
 async function loadComments() {
  const loadID = ++commentLoad; setStatus('Loading comments…');
  try {
   const data = await api(currentRoot + '/items/' + encodeURIComponent(item.id) + '/comments');
   if (loadID !== commentLoad || board !== currentBoard || root !== currentRoot || !section.isConnected) return false;
   if (!validComments(data)) throw new Error('Comments are invalid. Reopen the item to retry.');
   renderCommentList(list, data); setStatus(data.length ? `${data.length} comment${data.length === 1 ? '' : 's'}.` : 'No comments yet.'); return true;
  } catch (error) { if (loadID === commentLoad && board === currentBoard && root === currentRoot && section.isConnected) setStatus(error.message, true); return false; }
 }
 async function addComment() {
  if (!addButton || commentBusy || !canComment()) return; const body = textarea.value.trim();
  if (!body) { setStatus('Comment cannot be empty.', true); textarea.focus(); return; }
  commentBusy = true; commentLoad++; addButton.disabled = true; setStatus('Adding comment…');
  try {
   await api(currentRoot + '/items/' + encodeURIComponent(item.id) + '/comments', {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf,'Idempotency-Key':requestKey()}, body:JSON.stringify({body})});
   if (board !== currentBoard || root !== currentRoot || !section.isConnected) return; textarea.value = ''; refreshCommentPreview(); await loadComments();
  } catch (error) { if (board === currentBoard && root === currentRoot && section.isConnected) setStatus(error.message, true); }
  finally { commentBusy = false; if (addButton && section.isConnected) { addButton.disabled = !canComment(); renderControls(); } }
 }
 loadComments();
}
function editItem(item, draft) {
 const existing = !!item; const readOnly = board.role === 'viewer' || item?.archived; let desiredLinkIDs;
 item ||= { title: '', description: '', column_id: board.columns[0].id, project_id: ['all', 'none'].includes($('project').value) ? '' : $('project').value, sprint_ids: [], assignee: '', labels: [], dependencies: [] };
 openEditor(existing ? 'Work item' : 'Create work item', fields => {
  if (existing) $('editor-title').append(' ', helpPopover(`Card ID: ${item.id}\nRevision: ${item.revision}`, 'Work item details'));
  const layout = el('div', undefined, 'item-editor-layout'); const primary = el('div', undefined, 'item-editor-primary'); const controls = el('div', undefined, 'item-editor-controls'); layout.append(primary, controls); fields.append(layout);
  const title = field(primary, 'title', 'Title', draft?.title ?? item.title); title.required = true; title.maxLength = 240;
  markdownEditor(primary, 'description', 'Description', draft?.description ?? item.description, 16000, readOnly, true);
  multiSelect(controls, 'assignee', 'Assignee', [['', 'Unassigned'], ...board.members.map(m => [m.subject, memberName(m.subject)])], [draft?.assignee ?? item.assignee], undefined, undefined, {single:true});
  multiSelect(controls, 'labels', 'Labels', board.labels.map(label => [label.name, label.name]), draft?.labels ?? item.labels, (chip, value) => { const label = labelInfo(value); chip.style.backgroundColor = label.color; chip.style.color = labelForeground(label.color); chip.classList.add('label-badge'); }, 'Use Edit to add labels and × to remove them. Manage available labels from the Labels view.');
  multiSelect(controls, 'project_id', 'Project', [['', 'No project'], ...board.projects.map(p => [p.id, p.name])], [draft?.project_id ?? item.project_id], undefined, undefined, {single:true});
  multiSelect(controls, 'sprint_ids', 'Open sprints', board.sprints.filter(s => s.state !== 'closed').map(s => [s.id, `${s.name} (${s.state})`]), draft?.sprint_ids ?? item.sprint_ids, undefined, 'Select no open sprint to keep unfinished work in the backlog. One item may span several sprints without creating duplicate cards.');
  const closed = board.closed_scope.filter(s => s.item_id === item.id).map(scope => board.sprints.find(s => s.id === scope.sprint_id)?.name || scope.sprint_id);
  if (closed.length) controls.append(el('p', 'Closed sprint history (read-only): ' + closed.join(', '), 'help'));
  multiSelect(controls, 'dependencies', 'Depends on', board.items.filter(i => i.id !== item.id).map(i => [i.id, i.title]), draft?.dependencies ?? item.dependencies);
  if (existing) {
   const itemLinks = board.links.filter(link => link.items.includes(item.id));
   const linkPicker = multiSelect(controls, 'link_ids', 'GitLab links', board.links.map(link => [link.id, linkDisplayName(link)]), draft?.link_ids ?? itemLinks.map(link => link.id), undefined, 'Select registered merge requests to associate with this card. Paste a new MR URL below or use Add link when it is not listed.');
   if (!readOnly) inlineGitLabPaste(linkPicker.group, item, readOnly);
   const linkActions = el('div', undefined, 'actions');
   if (!readOnly) { const add = writeButton('Add link', () => addGitLabLink(item)); add.dataset.gitlabWrite = 'true'; add.disabled = !gitLabWritable(); linkActions.append(add); }
   else if (itemLinks.length) linkActions.append(button('View observations', () => { $('editor').close(); showLinks(item); }));
   if (linkActions.childElementCount) controls.append(linkActions);
  }
  controls.append(el('hr', undefined, 'item-editor-divider'));
  field(controls, 'column_id', 'Move to', draft?.column_id ?? item.column_id, 'text', board.columns.map(c => [c.id, c.name]));
  if (existing && !item.archived && !readOnly) {
   const archive = writeButton('Archive item', () => archiveItem(item), 'danger'); archive.dataset.itemFooter = 'true'; archive.dataset.write = 'true'; archive.classList.add('archive-footer'); $('editor-form').querySelector('.dialog-foot').insertBefore(archive, $('cancel'));
  }
  if (existing) renderItemComments(primary, item);
 }, data => {
  if (existing) desiredLinkIDs = data.getAll('link_ids');
  return { kind: existing ? 'item.update' : 'item.create', target: item.id || '', item: { ...item, title: data.get('title').trim(), description: data.get('description'), column_id: data.get('column_id'), project_id: data.get('project_id'), sprint_ids: data.getAll('sprint_ids'), assignee: data.get('assignee'), labels: data.getAll('labels'), dependencies: data.getAll('dependencies') } };
 }, readOnly, existing ? () => reconcileItemLinks(item.id, desiredLinkIDs || []) : undefined);
}
function archiveItem(item) {
 $('editor').close();
 openEditor('Archive work item', fields => {
  fields.append(el('p', `Archive “${item.title}” and remove it from all open sprints? History is retained and the item can be restored. Unsaved editor changes will not be applied.`));
  field(fields, 'reason', 'Archive rationale (optional)', '', 'textarea').maxLength = 4000;
 }, data => ({ kind: 'item.archive', target: item.id, reason: data.get('reason') }));
 $('save').textContent = 'Archive item';
}
function editSprint(sprint) {
 const existing = !!sprint; sprint ||= { name: '', goal: '', start: new Date().toISOString().slice(0, 10), end: new Date(Date.now() + 13 * 86400000).toISOString().slice(0, 10) };
 openEditor(existing ? 'Edit sprint' : 'Plan a sprint', fields => {
  const name = field(fields, 'name', 'Sprint name', sprint.name); name.required = true; name.maxLength = 120;
  const goal = field(fields, 'goal', 'Sprint goal · what outcome matters?', sprint.goal, 'textarea'); goal.required = true; goal.maxLength = 4000;
  const grid = el('div', undefined, 'form-grid'); fields.append(grid); field(grid, 'start', 'Start date', sprint.start, 'date').required = true; field(grid, 'end', 'End date', sprint.end, 'date').required = true;
  fields.append(el('p', 'Add or remove scope by editing an item’s sprint membership. Sprints belong to the workspace and can span projects. Multiple sprints can be active.', 'help'));
 }, data => ({ kind: 'sprint.save', target: sprint.id || '', sprint: { ...sprint, name: data.get('name').trim(), goal: data.get('goal').trim(), start: data.get('start'), end: data.get('end') } }));
}
function closeSprint(sprint) {
 const items = scopeItems(sprint); const unfinished = items.filter(i => !done(i));
 openEditor('Close sprint & decide carry-over', fields => {
  fields.append(el('p', `${sprint.name}: ${items.length} items in scope; ${unfinished.length} unfinished. Closing freezes this sprint’s scope. Other sprint assignments remain unchanged; the card keeps its identity and column.`));
  field(fields, 'destination', 'Also assign unfinished work to', '', 'text', [['', 'No additional sprint'], ...board.sprints.filter(s => s.state !== 'closed' && s.id !== sprint.id).map(s => [s.id, s.name])]);
  fields.append(el('p', 'No additional sprint returns an item to backlog only if it has no other open sprint membership. Existing memberships are never removed by closing another sprint.', 'help'));
  const reason = field(fields, 'reason', 'Closing decision / rationale', '', 'textarea'); reason.required = true; reason.maxLength = 4000;
 }, data => ({ kind: 'sprint.close', target: sprint.id, destination: data.get('destination'), reason: data.get('reason').trim() }));
 $('save').textContent = 'Close sprint';
}
function editColumn(column) {
 $('editor').close(); const existing = !!column; column ||= { name: '', category: 'todo', wip: 0 };
 openEditor(existing ? 'Edit board column' : 'Add board column', fields => {
  const name = field(fields, 'name', 'Column name', column.name); name.required = true; name.maxLength = 80;
  field(fields, 'category', 'Lifecycle category', column.category, 'text', [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']]);
  const wip = field(fields, 'wip', 'WIP limit · 0 means unlimited', String(column.wip), 'number'); wip.min = 0; wip.max = 1000; wip.required = true;
  fields.append(el('p', 'WIP counts all non-archived cards in this column, across sprints and backlog. A limit cannot be lowered below current occupancy.', 'help'));
 }, data => ({ kind: 'column.save', target: column.id || '', column: { ...column, name: data.get('name').trim(), category: data.get('category'), wip: Number(data.get('wip')) } }));
}
function editProject(project) {
 $('editor').close();
 openEditor(project ? 'Edit project' : 'Create project', fields => {
  const name = field(fields, 'name', 'Project name', project?.name || ''); name.required = true; name.maxLength = 120;
  fields.append(el('p', 'Projects classify work in this workspace. Boards, sprint scope, WIP and permissions stay workspace-wide.', 'help'));
 }, data => ({kind: 'project.save', target: project?.id || '', project: {...(project || {}), name: data.get('name').trim()}}));
}
function renderProjects(content) {
 const sections = el('div', undefined, 'maintenance-sections');
 const projects = el('section', undefined, 'maintenance-section'); const projectHead = el('div', undefined, 'section-head'); const newProject = writeButton('＋ New project', () => editProject(), 'primary'); newProject.dataset.write = 'true'; projectHead.append(el('h2', 'Workspace projects'), newProject); projects.append(projectHead, el('p', 'Projects classify work in this workspace. Boards, sprint scope, WIP and permissions stay workspace-wide.', 'help'));
 if (!board.projects.length) projects.append(el('p', 'No projects yet. Items can remain unclassified.', 'empty')); else { const list = el('div', undefined, 'maintenance-list'); board.projects.forEach(project => { const row = el('div', undefined, 'setup-row maintenance-row'); const info = el('div', undefined, 'maintenance-row-info'); info.append(el('strong', project.name)); const edit = writeButton('Edit project', () => editProject(project)); edit.dataset.write = 'true'; row.append(info, edit); list.append(row); }); projects.append(list); }
 const integration = el('section', undefined, 'maintenance-section');
 const integrationHead = el('div', undefined, 'section-head');
 integrationHead.append(el('h2', 'GitLab integration'));
 if (integrationFormOpen) {
  integration.append(integrationHead, renderIntegrationForm());
 } else {
  const review = writeButton('Review integration', reviewIntegration); review.dataset.write = 'true'; integrationHead.append(review);
  const configured = board.connector_instance || 'Not configured'; const approved = board.integration?.projects?.length || 0;
  integration.append(integrationHead, el('p', `Operator-configured GitLab instance: ${configured}`, 'help'), el('p', `${approved} approved GitLab project${approved === 1 ? '' : 's'}.`, 'help'));
  if (!board.connector_instance) integration.append(el('p', 'Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN to enable the connector.', 'help'));
 }
 sections.append(projects, integration); content.append(sections);
}
function editLabel(label) {
 $('editor').close(); const originalName = typeof label === 'string' ? label : label?.name || ''; const originalColor = typeof label === 'string' ? labelInfo(label).color : label?.color || '#dcefe4';
 openEditor(originalName ? 'Rename label' : 'Create label', fields => {
  const input = field(fields, 'name', 'Label name', originalName); input.required = true; input.maxLength = 60;
  labelColorPicker(fields, originalColor);
  fields.append(el('p', 'Use optional scope::value names such as type::bug or priority::high. Choose from the fixed 64-swatch palette. Renaming updates every assigned card, including archived work.', 'help'));
 }, data => ({kind: 'label.save', target: originalName, name: data.get('name').trim(), color: data.get('color') || originalColor}));
}
function deleteLabel(label) {
 $('editor').close(); openEditor('Delete label', fields => { fields.append(el('p', `Remove “${label.name}” from the workspace and all ${board.items.filter(i => i.labels.includes(label.name)).length} assigned cards, including archived work? Historical audit is retained.`)); }, () => ({kind: 'label.delete', target: label.name})); $('save').textContent = 'Delete label';
}
function renderLabels(content) {
 $('count').textContent = board.labels.length ? `${board.labels.length} label${board.labels.length === 1 ? '' : 's'}` : '';
 const heading = el('div', undefined, 'section-head'); const newLabel = writeButton('＋ New label', () => editLabel(), 'primary'); newLabel.dataset.write = 'true'; heading.append(el('h2', 'Workspace labels'), newLabel); content.append(heading, el('p', 'Create, rename and remove the reusable labels used to classify work in this workspace.', 'help'));
 if (!board.labels.length) { content.append(el('p', 'No labels yet. Create reusable labels for this workspace.', 'empty')); return; }
 const list = el('div', undefined, 'label-maintenance-list'); board.labels.forEach(label => { const row = el('article', undefined, 'setup-row label-maintenance-row'); const summary = el('div', undefined, 'label-maintenance-summary'); const usage = board.items.filter(item => item.labels.includes(label.name)).length; summary.append(labelBadge(label.name), el('small', `${usage} card${usage === 1 ? '' : 's'}`, 'muted')); const actions = el('div', undefined, 'actions'); const rename = writeButton('Rename', () => editLabel(label)); rename.dataset.write = 'true'; const remove = writeButton('Delete…', () => deleteLabel(label), 'danger'); remove.dataset.write = 'true'; actions.append(rename, remove); row.append(summary, actions); list.append(row); }); content.append(list);
}
function editMemberName(member) {
 $('editor').close(); openEditor('Member display name', fields => { const input = field(fields, 'name', 'Display name', member.name || (member.subject === session.subject && session.name) || ''); input.required = true; input.maxLength = 120; }, data => ({kind: 'member.name', target: member.subject, name: data.get('name').trim()}));
}
function renderMembers(content) {
 const heading = el('div', undefined, 'section-head'); heading.append(el('h2', 'Workspace members')); content.append(heading, el('p', 'Names identify assignees; changing a display name never changes membership or permissions. Only workspace admins can edit names.', 'help'));
 if (!board.members.length) { content.append(el('p', 'No workspace members yet.', 'empty')); return; }
 const list = el('div', undefined, 'maintenance-list'); board.members.forEach(member => { const row = el('div', undefined, 'setup-row maintenance-row'); const info = el('div', undefined, 'maintenance-row-info'); info.append(el('strong', memberName(member.subject)), el('small', `${member.subject} · ${member.role}`, 'muted')); if (board.role === 'admin') { const edit = writeButton('Edit name', () => editMemberName(member)); edit.dataset.write = 'true'; row.append(info, edit); } else row.append(info); list.append(row); }); content.append(list);
}
function observationTiming(link) {
 const timestamp = value => { if (!value) return 'none yet'; const date = new Date(value); return Number.isNaN(date.getTime()) ? 'unavailable' : date.toLocaleString(); };
 return `Last successful refresh: ${timestamp(link.last_success)} · Latest refresh attempt: ${timestamp(link.last_attempt)}`;
}
function gitlabProjectLabel(project) {
 const name = String(project.name || '').trim(); const path = String(project.path_with_namespace || '').trim();
 return `${name}${path && path !== name ? ` · ${path}` : ''} (#${project.id})`;
}
function integrationProjectEntries(projects, selected) {
 const entries = []; const seen = new Set();
 projects.forEach(project => {
  if (!Number.isSafeInteger(project.id) || project.id <= 0 || typeof project.name !== 'string' || !project.name.trim()) return;
  const value = String(project.id); if (seen.has(value)) return; seen.add(value); entries.push([value, gitlabProjectLabel(project)]);
 });
 selected.forEach(value => { if (!seen.has(value)) entries.push([value, `Project ${value} (currently approved)`]); });
 return entries;
}
function validGitLabProjectCatalog(data) { return Array.isArray(data) && data.every(project => project && Number.isSafeInteger(project.id) && project.id > 0 && typeof project.name === 'string' && project.name.trim()); }
async function loadGitLabProjects(currentRoot) {
 const data = await api(currentRoot + '/gitlab/projects');
 if (!validGitLabProjectCatalog(data)) throw new Error('GitLab project catalog is invalid. Refresh to retry.');
 return data;
}
function approvedGitLabProjectEntries(projects) {
 const approved = new Set(board.integration.projects.map(String));
 return integrationProjectEntries(projects.filter(project => approved.has(String(project.id))), board.integration.projects.map(String));
}
function mergeRequestLabel(mergeRequest) {
 const title = String(mergeRequest.title || '').trim(); const state = String(mergeRequest.state || '').trim(); const timestamp = typeof mergeRequest.updated_at === 'string' ? Date.parse(mergeRequest.updated_at) : NaN; const updated = Number.isNaN(timestamp) ? '' : ` · updated ${new Date(timestamp).toLocaleDateString()}`;
 return `MR !${mergeRequest.iid} · ${title}${state ? ` · ${state}` : ''}${mergeRequest.draft ? ' · Draft' : ''}${updated}`;
}
function validGitLabMergeRequestCatalog(data) { return Array.isArray(data) && data.every(mergeRequest => mergeRequest && Number.isSafeInteger(mergeRequest.iid) && mergeRequest.iid > 0 && typeof mergeRequest.title === 'string' && mergeRequest.title.trim()); }
function mergeRequestEntries(mergeRequests, selected) {
 const entries = []; const seen = new Set();
 mergeRequests.forEach(mergeRequest => {
  if (!Number.isSafeInteger(mergeRequest.iid) || mergeRequest.iid <= 0 || typeof mergeRequest.title !== 'string' || !mergeRequest.title.trim()) return;
  const value = String(mergeRequest.iid); if (seen.has(value)) return; seen.add(value); entries.push([value, mergeRequestLabel(mergeRequest)]);
 });
 selected.forEach(value => { if (!seen.has(value)) entries.push([value, `MR !${value} (currently selected)`]); });
 return entries;
}
function reviewIntegration() {
 if (!board || busy || loading || integrationFormOpen) return;
 integrationFormOpen = true; integrationCatalog = []; integrationCatalogError = '';
 integrationCatalogLoading = false;
 if (board.role === 'admin' && board.connector_instance) loadIntegrationCatalog(); else render();
}
async function loadIntegrationCatalog() {
 if (!board || !integrationFormOpen || integrationCatalogLoading) return;
 const currentBoard = board, currentRoot = root; integrationCatalogLoading = true; integrationCatalogError = '';
 render(); notice('Loading available GitLab projects…');
 try { integrationCatalog = await loadGitLabProjects(currentRoot); } catch (e) { integrationCatalogError = e.message; }
 integrationCatalogLoading = false;
 if (board === currentBoard && root === currentRoot && integrationFormOpen && view === 'projects') { notice(''); render(); }
}
function renderIntegrationForm() {
 const currentBoard = board; const readOnly = currentBoard.role !== 'admin';
 const selected = currentBoard.integration.projects.map(String);
 const form = el('form', undefined, 'inline-maintenance-form');
 form.append(el('p', `Operator-configured instance: ${currentBoard.connector_instance || 'Not configured'}`, 'help'));
 form.append(el('p', `Existing approval: ${currentBoard.integration.instance || 'None'}`, 'help'));
 multiSelect(form, 'projects', 'Approved GitLab projects', integrationProjectEntries(integrationCatalog, selected), selected, undefined, 'Choose projects visible to the configured server-side read connector. The selected projects and their engineering metadata are shared with every workspace reader.');
 if (integrationCatalogLoading) form.append(el('p', 'Loading available GitLab projects…', 'help'));
 if (integrationCatalogError) {
  const error = el('p', `Could not load the GitLab project list. ${integrationCatalogError} Existing approvals remain available so they are not removed accidentally.`, 'error'); error.setAttribute('role', 'alert'); form.append(error);
  const retry = button('Retry loading projects', loadIntegrationCatalog); retry.disabled = readOnly || integrationCatalogLoading; form.append(retry);
 } else if (currentBoard.connector_instance && !integrationCatalogLoading && !integrationCatalog.length) {
  form.append(el('p', 'No GitLab projects are visible to the configured read connector.', 'help'));
 }
 form.append(el('p', 'Every workspace member, including viewers and authorized machine readers, can see engineering metadata from these projects. Revoking a project or changing the instance removes its links and cached observations; cards and audit remain. No selected projects disables the integration.', 'help'));
 const consent = field(form, 'consent', 'I approve this metadata visibility and any removals', 'yes', 'checkbox'); consent.required = true; consent.parentElement.classList.add('consent');
 if (!currentBoard.connector_instance) form.append(el('p', 'Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN. Planning works without a connector.', 'help'));
 const error = el('p', '', 'error'); error.hidden = true; error.setAttribute('role', 'alert'); form.append(error);
 const actions = el('div', undefined, 'dialog-foot inline-maintenance-actions'); const cancel = button('Cancel', () => { integrationFormOpen = false; integrationCatalog = []; integrationCatalogError = ''; integrationCatalogLoading = false; render(); }); actions.append(cancel);
 let save;
 if (!readOnly) { save = button('Save changes', undefined, 'primary'); save.type = 'submit'; save.disabled = integrationCatalogLoading; actions.append(save); }
 form.append(actions);
 if (readOnly || integrationCatalogLoading) {
  form.querySelectorAll('input,select,textarea').forEach(input => { input.disabled = true; });
  form.querySelectorAll('[data-multi-edit],[data-multi-remove]').forEach(input => { input.disabled = true; });
 }
 form.addEventListener('submit', async event => {
  event.preventDefault(); if (readOnly || !save || busy || integrationCatalogLoading) return;
  const parts = new FormData(form).getAll('projects');
  try {
   if (parts.length > 100) throw new Error('Select at most 100 GitLab projects.');
   if (parts.some(value => !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error('Choose only positive numeric GitLab projects.');
   if (new Set(parts).size !== parts.length) throw new Error('A GitLab project may only be selected once.');
   integrationFormOpen = false; save.disabled = true; cancel.disabled = true;
   await change({revision:board.workspace.revision, kind:'integration.save', integration:{instance:board.connector_instance, projects:parts.map(Number)}});
   integrationCatalog = []; integrationCatalogError = ''; integrationCatalogLoading = false; render();
  } catch (submitError) {
   integrationFormOpen = true; error.textContent = `${submitError.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`; error.hidden = false; save.disabled = false; cancel.disabled = false; renderControls();
  }
 });
 return form;
}
function showLinks(item) {
 const ready = board.connector_instance && board.connector_instance === board.integration.instance;
 openEditor('Linked GitLab observations', fields => {
  fields.append(el('p', `${item.title} · ${board.integration.instance || 'No approved integration'}`, 'help'));
  fields.append(el('p', `Engineering observations only. Refresh does not move cards or change sprint scope. ${board.refresh_seconds ? `Background refresh: about every ${board.refresh_seconds} seconds, with backoff on failures. Webhook hints can request an earlier refresh.` : 'Automatic refresh is disabled; use manual refresh.'} Observations older than five minutes or awaiting refresh are stale. This dialog is a snapshot; reopen to see background results.`, 'help'));
  const links = board.links.filter(l => l.items.includes(item.id));
  if (!links.length) fields.append(el('p', 'Unlinked. Add an approved MR; never infer links from card titles.', 'empty'));
  links.forEach(link => {
   const row = el('article', undefined, 'setup-row'); const obs = link.observation; const linkRow = el('div', undefined, 'card-links'); linkRow.append(cardLinkView(link)); const pipelineLink = pipelineLinkView(link); if (pipelineLink) linkRow.append(pipelineLink); row.append(linkRow);
   if (obs?.title) row.append(el('p', obs.title));
   if (obs?.mr_state) row.append(el('p', `${obs.draft ? 'Draft · ' : ''}Review/mergeability: ${obs.review || 'unknown'} · Head SHA ${obs.head_sha || 'unknown'}`, 'help'));
   if (obs?.pipeline) row.append(el('p', `${link.kind === 'mr' ? 'Latest MR pipeline status' : 'Pipeline status'}: ${obs.pipeline.state || 'unknown'} · SHA ${obs.pipeline.sha || 'unknown'} · Provider state ${obs.pipeline.provider_state || 'unknown'}`, 'help'));
   const outcomes = {unobserved:'Not refreshed',ok:'Last attempt succeeded',inaccessible:'GitLab denied access',not_found:'Not found or hidden by GitLab',unavailable:'GitLab unavailable',invalid_response:'Invalid GitLab response',rate_limited:'GitLab rate limited',busy:'Connector busy',disabled:'Connector disabled',outdated:'Older provider version ignored; cached data retained',refreshing:'Refresh requested; retry after cooldown if interrupted'};
   row.append(el('p', outcomes[link.outcome] || 'Unknown outcome', 'help'));
   row.append(el('p', observationTiming(link), 'help'));
   const actions = el('div', undefined, 'actions'); const key = requestKey();
   const refreshButton = writeButton('Refresh observation', async () => {
    if (!writable()) return;
    try { await change({kind:'link.refresh', target:link.id, revision:board.workspace.revision}, key); $('editor').close(); showLinks(board.items.find(i => i.id === item.id)); }
    catch(e) { $('form-error').textContent = e.message + ' Refresh the board to see current status; cooldowns prevent duplicate requests.'; }
   });
   refreshButton.dataset.refreshLink = link.id;
   refreshButton.disabled ||= !ready || !!link.next_refresh && Date.parse(link.next_refresh) > Date.now();
   actions.append(refreshButton);
   if (link.next_refresh && Date.parse(link.next_refresh) > Date.now()) row.append(el('p', `Next refresh after ${new Date(link.next_refresh).toLocaleTimeString()}. The refresh control becomes available after that time.`, 'help'));
   row.append(actions); fields.append(row);
  });
  if (!ready) fields.append(el('p', 'Connector unavailable or instance approval needs updating. An admin can review Projects settings.', 'help'));
 }, () => ({}), true);
}
function setupBoard() {
 openEditor('Board setup', fields => {
  fields.append(el('p', 'Configure columns, lifecycle categories, ordering, and WIP policy. All changes are revision checked.', 'help'));
  board.columns.forEach((c, index) => { const row = el('div', undefined, 'setup-row'); row.append(el('strong', c.name), el('small', `${c.category} · WIP ${c.wip || 'unlimited'}`, 'muted')); const actions = el('div', undefined, 'actions'); actions.append(writeButton('Edit', () => editColumn(c)));
   if (index > 0) actions.append(writeButton('Move left', async () => { await quick({ kind: 'column.rank', target: c.id, before: board.columns[index - 1].id }); $('editor').close(); }));
   if (board.columns.length > 1) actions.append(writeButton('Remove…', () => { $('editor').close(); openEditor('Remove column & move cards', f => { f.append(el('p', `All cards in ${c.name}, including archived ones, must move to another column.`)); field(f, 'destination', 'Destination column', '', 'text', board.columns.filter(v => v.id !== c.id).map(v => [v.id, v.name])); }, data => ({ kind: 'column.delete', target: c.id, destination: data.get('destination') })); }));
   row.append(actions); fields.append(row);
  }); fields.append(writeButton('＋ Add column', () => editColumn(), 'primary'));
 }, () => ({}), true);
}
$('editor').addEventListener('cancel', e => { e.preventDefault(); if (!busy) closeEditor(); });
$('editor').addEventListener('click', e => { if (!busy && e.target === $('editor')) closeEditor(); });
document.addEventListener('pointerdown', e => { const editor = $('editor'); if (!editor.open || busy) return; const r = editor.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeEditor(); });
$('dismiss').onclick = $('cancel').onclick = () => { if (!busy) closeEditor(); };
$('proposals').onclick = () => showProposals();
$('new-item').onclick = () => editItem(); $('columns').onclick = setupBoard; $('refresh').onclick = refresh;
$('scope').onchange = render;
$('label').onchange = $('search').oninput = renderContent;
$('project').onchange = $('assignee').onchange = () => { resetBurndown(); render(); if (!burndownRequests.size) $('content').setAttribute('aria-busy', 'false'); };
document.querySelectorAll('[data-view]').forEach(b => { b.onclick = async () => { if (loading || busy || integrationFormOpen) return; view = b.dataset.view; if (view === 'history') { try { await loadHistory(true); } catch (e) { notice(e.message, true); } } render(); }; });
async function chooseWorkspace() {
 integrationFormOpen = false; integrationCatalog = []; integrationCatalogError = ''; integrationCatalogLoading = false;
 board = undefined; resetBurndown(); burndownExpanded.clear(); $('project').value = 'all'; $('assignee').value = 'all'; $('label').value = 'all'; $('scope').value = 'active'; $('search').value = ''; render();
 root = `/api/v2/workspaces/${encodeURIComponent($('workspace').value)}`;
 await refresh();
}
$('workspace').onchange = chooseWorkspace;
let observationPoll = false;
setInterval(async () => {
 if (!board?.refresh_seconds || busy || loading || integrationFormOpen || drag || document.hidden || $('editor').open || observationPoll) return;
 const current = board, path = root; observationPoll = true;
 try {
  const next = await api(path + '/board');
  if (board !== current || root !== path || busy || loading || integrationFormOpen || drag || $('editor').open) return;
  if (next.workspace.revision !== board.workspace.revision || next.role !== board.role) { notice('Planning or permissions changed elsewhere. Use Refresh to review.'); return; }
  board.links = next.links; renderContent();
 } catch (e) { if (board === current && !busy && !integrationFormOpen && !$('editor').open) notice('Observation cache could not be reloaded. Use Refresh to retry.', true); }
 finally { observationPoll = false; }
}, 15000);
// Local freshness/cooldowns require no additional network requests.
setInterval(() => {
 if (!board) return;
 document.querySelectorAll('[data-refresh-link]').forEach(node => { const link = board.links.find(l => l.id === node.dataset.refreshLink); node.disabled = !writable() || !link || !board.connector_instance || board.connector_instance !== board.integration.instance || !!link.next_refresh && Date.parse(link.next_refresh) > Date.now(); });
}, 10000);
renderControls();
(async () => { try { session = await api('/api/v2/session'); $('identity').textContent = session.name || session.subject; workspaces = await api('/api/v2/workspaces'); options($('workspace'), workspaces.map(w => [w.id, w.name])); if (!workspaces.length) { notice('No workspace membership. Ask an operator to grant your login subject access: ' + session.subject); render(); return; } await chooseWorkspace(); } catch (e) { notice(e.message, true); renderControls(); } })();
