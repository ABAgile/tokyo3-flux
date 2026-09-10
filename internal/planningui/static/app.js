'use strict';
const $ = id => document.getElementById(id);
let session, workspaces = [], board, root, view = 'board', busy = false, loading = false;
let history = [], historyBefore = 0, historyMore = false, loadGeneration = 0;
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
$('theme').onclick = () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; localStorage.setItem('flux-plan-theme', next); };
function el(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function button(text, fn, className) { const b = el('button', text, className); b.type = 'button'; b.onclick = fn; return b; }
function writable() { return board && board.role !== 'viewer' && !busy && !loading; }
function writeButton(text, fn, className) { const b = button(text, fn, className); b.disabled = !writable(); return b; }
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
function options(select, entries, value) { select.replaceChildren(...entries.map(([id, text]) => { const o = el('option', text); o.value = id; return o; })); if (value !== undefined) select.value = value; }
async function api(path, init = {}) { const r = await fetch(path, { ...init, headers: { 'Accept': 'application/json', ...init.headers } }); if (r.redirected) throw new Error('Session expired. Reload the page to sign in.'); let data; try { data = await r.json(); } catch { throw new Error('Planning service unavailable. Refresh to retry.'); } if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`); return data; }
async function refresh() {
 if (!root || busy) return;
 const generation = ++loadGeneration; loading = true; renderControls(); $('content').setAttribute('aria-busy', 'true');
 try { const next = await api(root + '/board'); if (generation !== loadGeneration) return false; board = next; history = []; historyBefore = 0; if (view === 'history') await loadHistory(true); notice(`Up to date · workspace revision ${board.workspace.revision}`); return true; }
 catch (e) { if (generation === loadGeneration) notice(e.message, true); return false; }
 finally { if (generation === loadGeneration) { loading = false; render(); $('content').setAttribute('aria-busy', 'false'); } }
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
function renderControls() { document.querySelectorAll('[data-write]').forEach(b => { b.disabled = !writable(); }); document.querySelectorAll('[data-drag-type]').forEach(e => { e.draggable = writable(); }); $('refresh').disabled = busy || loading; $('workspace').disabled = busy || loading; $('project').disabled = busy || loading; $('label').disabled = busy || loading; }
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
 if (info.avatarURL) { const image = el('img'); image.src = info.avatarURL; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; image.onerror = () => image.remove(); avatar.append(image); }
 node.append(avatar, el('span', info.name)); return node;
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
 actions.append(button('View scope', () => { view = 'board'; render(); $('scope').value = s.id; renderContent(); }));
 if (s.state !== 'closed') actions.append(writeButton('Edit sprint', () => editSprint(s)));
 if (s.state === 'planned') actions.append(writeButton('Start sprint', () => quick({ kind: 'sprint.start', target: s.id }), 'primary'));
 if (s.state === 'active') actions.append(writeButton('Close sprint', () => closeSprint(s)));
 if (s.state === 'closed') info.append(el('small', 'Scope preserved at closure. Card details reflect current work; historical state is retained in audit.', 'muted'));
 panel.append(info, metrics, actions); return panel;
}
function render() {
 renderControls();
 if (!board) { $('sprint-summary').replaceChildren(); $('count').textContent = ''; $('content').replaceChildren(el('p', 'Choose an available workspace to begin. Projects are optional.', 'empty')); return; }
 $('breadcrumb').textContent = board.workspace.name + ' / Shared planning';
 const projectFilter = $('project').value; options($('project'), [['all', 'All projects'], ['none', 'No project'], ...board.projects.map(p => [p.id, p.name])], projectFilter); if (!$('project').value) $('project').value = 'all';
 const labelFilter = $('label').value; options($('label'), [['all', 'All labels'], ['none', 'No labels'], ...board.labels.map(label => [label.name, label.name])], labelFilter); if (!$('label').value) $('label').value = 'all'; styleLabelOptions($('label'));
 const titles = { board: 'Kanban board', backlog: 'Backlog', sprints: 'Sprint planning', archive: 'Archived work', history: 'Planning history' };
 $('title').textContent = titles[view]; $('subtitle').textContent = board.role === 'viewer' ? 'Read-only workspace access.' : 'Plan intentionally. Keep work moving.';
 document.querySelectorAll('[data-view]').forEach(b => { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
 const active = activeSprints(); $('sprint-summary').replaceChildren(...(view === 'board' || view === 'backlog' ? (active.length ? active.map(sprintPanel) : [el('p', 'No active sprint. Use Sprint planning to create and start one, or keep a continuous Kanban flow.', 'empty')]) : []));
 const selected = $('scope').value; options($('scope'), [['all', 'All open work'], ['active', 'Active sprints'], ['backlog', 'Backlog'], ...board.sprints.map(s => [s.id, `${s.name} (${s.state})`])], selected); if (!$('scope').value) $('scope').value = 'all';
 $('scope-label').hidden = view !== 'board'; document.querySelector('.toolbar').hidden = view === 'sprints' || view === 'history';
 renderContent();
}
function filteredItems() {
 const query = $('search').value.toLowerCase(); const scope = view === 'backlog' ? 'backlog' : $('scope').value; const sprint = board.sprints.find(s => s.id === scope);
 return board.items.filter(i => {
  if (view === 'archive') { if (!i.archived) return false; } else if (i.archived && sprint?.state !== 'closed') return false;
  if (view !== 'archive') { if (scope === 'active' && !activeSprints().some(s => i.sprint_ids.includes(s.id))) return false; if (scope === 'backlog' && (i.sprint_ids.length || done(i))) return false; if (sprint && !scopeItems(sprint).some(v => v.id === i.id)) return false; }
  const project = $('project').value; if (project === 'none' && i.project_id) return false; if (project !== 'all' && project !== 'none' && i.project_id !== project) return false;
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
 c.append(top, el('small', projectName(item.project_id), 'muted'));
 const sprintTags = el('div', undefined, 'tags'); item.sprint_ids.forEach(id => sprintTags.append(el('span', board.sprints.find(s => s.id === id)?.name || id, 'badge'))); c.append(sprintTags);
 const tags = el('div', undefined, 'tags'); item.labels.forEach(l => tags.append(labelBadge(l))); if (blocked(item)) tags.append(el('span', 'Blocked by dependency', 'badge warning')); if (item.archived) tags.append(el('span', 'Archived', 'badge')); c.append(tags);
 c.append(assigneeView(item.assignee));
 if (item.archived) {
  const controls = el('div', undefined, 'card-controls');
  controls.append(writeButton('Restore item', () => quick({ kind: 'item.restore', target: item.id })));
  c.append(controls);
 }
 const links = board.links.filter(l => l.items.includes(item.id));
 links.forEach(l => c.append(observationSummary('small', l)));
 c.append(button(`GitLab links · ${links.length}`, () => showLinks(item)));
 return c;
}
function renderContent() {
 if (!board) return; const content = $('content'); content.replaceChildren();
 if (view === 'sprints') {
  const head = el('div', undefined, 'section-head'); head.append(el('h2', 'Goals, scope, and deliberate carry-over'), writeButton('＋ New sprint', () => editSprint(), 'primary')); content.append(head);
  const list = el('div', undefined, 'sprints'); board.sprints.forEach(s => list.append(sprintPanel(s))); if (!board.sprints.length) list.append(el('p', 'No sprints yet. Create a goal and time box, then add work from the backlog.', 'empty')); content.append(list); return;
 }
 if (view === 'history') { renderHistory(content); return; }
 const items = filteredItems(); $('count').textContent = `${items.length} items · workspace revision ${board.workspace.revision}`;
 if (view === 'board') { const grid = el('div', undefined, 'board'); for (const col of board.columns) { const section = el('section', undefined, 'column'); section.setAttribute('aria-label', col.name); const head = el('div', undefined, 'column-head'); const peers = items.filter(i => i.column_id === col.id); const total = board.items.filter(i => !i.archived && i.column_id === col.id).length; head.append(el('h3', col.name), el('small', `${peers.length} shown · ${col.wip ? `${total}/${col.wip} WIP` : 'No limit'}`)); makeDraggable(head, 'list', col.id, col.name); section.dataset.column = col.id; dropZone(section, 'card', id => ({kind: 'item.move', target: id, destination: col.id}), 'end'); dropZone(section, 'list', (id, after) => ({kind: 'column.rank', target: id, before: after ? board.columns[board.columns.findIndex(c => c.id === col.id) + 1]?.id || '' : col.id}), 'x'); section.append(head); appendCards(section, peers); if (!peers.length) section.append(el('p', 'No work here', 'empty')); grid.append(section); } content.append(grid); }
 else { const list = el('div', undefined, 'list'); appendCards(list, items); if (!items.length) list.append(el('p', view === 'backlog' ? 'Backlog is clear. Create work without a sprint to plan what comes next.' : 'No matching work.', 'empty')); content.append(list); }
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
function labelColorPicker(parent, value) {
 const palette = el('fieldset', undefined, 'label-palette'); palette.append(el('legend', 'Label color'));
 const selected = String(value || '').trim().toLowerCase();
 LABEL_PALETTE.forEach(color => { const input = el('input'); input.type = 'radio'; input.name = 'color'; input.value = color; input.checked = color === selected; input.setAttribute('aria-label', color); input.title = color; input.style.backgroundColor = color; palette.append(input); });
 parent.append(palette); return palette;
}
function openEditor(title, build, submit, readOnly = false) {
 $('editor-title').textContent = title; $('fields').replaceChildren(); $('form-error').textContent = ''; $('save').textContent = 'Save changes'; $('save').hidden = readOnly; $('save').disabled = false;
 const revision = board.workspace.revision; let pending, key; build($('fields'));
 if (readOnly) $('fields').querySelectorAll('input,textarea,select').forEach(e => { e.disabled = true; });
 $('editor-form').onsubmit = async e => {
  e.preventDefault(); if (readOnly || busy) return; $('form-error').textContent = ''; $('save').disabled = true; $('cancel').disabled = true; $('dismiss').disabled = true;
  try {
   const command = { revision, ...submit(new FormData($('editor-form'))) };
   const serialized = JSON.stringify(command); if (pending !== serialized) { key = requestKey(); pending = serialized; }
   await change(command, key); $('editor').close();
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
function editItem(item) {
 const existing = !!item; item ||= { title: '', description: '', column_id: board.columns[0].id, project_id: ['all', 'none'].includes($('project').value) ? '' : $('project').value, sprint_ids: [], assignee: '', labels: [], dependencies: [] };
 openEditor(existing ? 'Work item' : 'Create work item', fields => {
  const title = field(fields, 'title', 'Title', item.title); title.required = true; title.maxLength = 240;
  const desc = field(fields, 'description', 'Description', item.description, 'textarea'); desc.maxLength = 16000;
  const grid = el('div', undefined, 'form-grid'); fields.append(grid);
  field(grid, 'column_id', 'Board column', item.column_id, 'text', board.columns.map(c => [c.id, c.name]));
  field(grid, 'project_id', 'Project', item.project_id, 'text', [['', 'No project'], ...board.projects.map(p => [p.id, p.name])]);
  const sprints = field(fields, 'sprint_ids', 'Open sprints · select multiple with Ctrl / Command', '', 'text', board.sprints.filter(s => s.state !== 'closed').map(s => [s.id, `${s.name} (${s.state})`])); sprints.multiple = true; sprints.size = 4;
  [...sprints.options].forEach(o => { o.selected = item.sprint_ids.includes(o.value); });
  fields.append(el('p', 'Select no open sprint to keep unfinished work in the backlog. One item may span several sprints without creating duplicate cards.', 'help'));
  const closed = board.closed_scope.filter(s => s.item_id === item.id).map(scope => board.sprints.find(s => s.id === scope.sprint_id)?.name || scope.sprint_id);
  if (closed.length) fields.append(el('p', 'Closed sprint history (read-only): ' + closed.join(', '), 'help'));
  field(grid, 'assignee', 'Assignee', item.assignee, 'text', [['', 'Unassigned'], ...board.members.map(m => [m.subject, memberName(m.subject)])]);
  const labels = field(fields, 'labels', 'Labels · select multiple with Ctrl / Command', '', 'text', board.labels.map(label => [label.name, label.name])); labels.multiple = true; labels.size = 4; [...labels.options].forEach(o => { o.selected = item.labels.includes(o.value); }); styleLabelOptions(labels);
  fields.append(el('p', 'Manage available labels using Labels in the workspace header. Select none to clear labels.', 'help'));
  const deps = field(fields, 'dependencies', 'Depends on · select multiple with Ctrl / Command', '', 'text', board.items.filter(i => i.id !== item.id).map(i => [i.id, i.title])); deps.multiple = true; deps.size = Math.min(5, Math.max(2, board.items.length - 1)); [...deps.options].forEach(o => { o.selected = item.dependencies.includes(o.value); });
  field(fields, 'reason', 'Decision note (optional)', '', 'textarea').maxLength = 4000;
  if (existing) { fields.append(el('p', `Item revision ${item.revision} · Native ID ${item.id}`, 'help')); if (!item.archived) fields.append(writeButton('Archive item', () => archiveItem(item), 'danger')); }
 }, data => ({ kind: existing ? 'item.update' : 'item.create', target: item.id || '', reason: data.get('reason'), item: { ...item, title: data.get('title').trim(), description: data.get('description'), column_id: data.get('column_id'), project_id: data.get('project_id'), sprint_ids: data.getAll('sprint_ids'), assignee: data.get('assignee'), labels: data.getAll('labels'), dependencies: data.getAll('dependencies') } }), board.role === 'viewer' || item.archived);
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
function manageProjects() {
 openEditor('Workspace projects', fields => {
  board.projects.forEach(p => { const row = el('div', undefined, 'section-head'); row.append(el('strong', p.name), writeButton('Edit project', () => editProject(p))); fields.append(row); });
  if (!board.projects.length) fields.append(el('p', 'No projects yet. Items can remain unclassified.', 'help'));
  fields.append(writeButton('＋ New project', () => editProject(), 'primary'));
 }, () => ({}), true);
}
function editLabel(label) {
 $('editor').close(); const originalName = typeof label === 'string' ? label : label?.name || ''; const originalColor = typeof label === 'string' ? labelInfo(label).color : label?.color || '#dcefe4';
 openEditor(originalName ? 'Rename label' : 'Create label', fields => {
  const input = field(fields, 'name', 'Label name', originalName); input.required = true; input.maxLength = 60;
  labelColorPicker(fields, originalColor);
  fields.append(el('p', 'Use optional scope::value names such as type::bug or priority::high. Choose from the fixed 64-swatch palette. Renaming updates every assigned card, including archived work.', 'help'));
 }, data => ({kind: 'label.save', target: originalName, name: data.get('name').trim(), color: data.get('color') || originalColor}));
}
function manageLabels() {
 openEditor('Workspace labels', fields => {
  board.labels.forEach(label => { const row = el('div', undefined, 'setup-row'); const actions = el('div', undefined, 'actions');
   actions.append(writeButton('Rename', () => editLabel(label)), writeButton('Delete…', () => { $('editor').close(); openEditor('Delete label', f => { f.append(el('p', `Remove “${label.name}” from the workspace and all ${board.items.filter(i => i.labels.includes(label.name)).length} assigned cards, including archived work? Historical audit is retained.`)); }, () => ({kind: 'label.delete', target: label.name})); $('save').textContent = 'Delete label'; }, 'danger'));
   row.append(labelBadge(label.name), actions); fields.append(row);
  });
  if (!board.labels.length) fields.append(el('p', 'No labels yet. Create reusable labels for this workspace.', 'help'));
  fields.append(writeButton('＋ New label', () => editLabel(), 'primary'));
 }, () => ({}), true);
}
function manageMembers() {
 openEditor('Workspace members', fields => {
  fields.append(el('p', 'Names identify assignees; changing a display name never changes membership or permissions. Only workspace admins can edit names.', 'help'));
  board.members.forEach(m => { const row = el('div', undefined, 'setup-row'); row.append(el('strong', memberName(m.subject)), el('small', `${m.subject} · ${m.role}`, 'muted'));
   if (board.role === 'admin') row.append(writeButton('Edit name', () => { $('editor').close(); openEditor('Member display name', f => { const input = field(f, 'name', 'Display name', m.name || (m.subject === session.subject ? session.name : '') || ''); input.required = true; input.maxLength = 120; }, data => ({kind: 'member.name', target: m.subject, name: data.get('name').trim()})); }));
   fields.append(row);
  });
 }, () => ({}), true);
}
function observationSummary(tag, link) { const node = el(tag, linkSummary(link), 'muted'); node.dataset.observation = link.id; return node; }
function linkSummary(link) {
 const obs = link.observation; const prefix = `${link.kind === 'mr' ? 'MR !' : 'Pipeline #'}${link.number} · project ${link.project}`;
 const age = link.last_success ? Date.now() - Date.parse(link.last_success) : Infinity;
 const freshness = !obs ? 'unknown' : age > 300000 || link.outcome !== 'ok' || link.refresh_pending ? 'stale' : 'observed';
 const pipe = obs?.pipeline;
 const state = pipe ? `pipeline ${pipe.state}${link.kind === 'mr' && !pipe.current_head ? ' (not current head)' : ''}` : 'no pipeline observed';
 return `${prefix} · ${obs?.mr_state || ''} ${state} · ${freshness}`;
}
function editIntegration() {
 openEditor('GitLab integration approval', fields => {
  fields.append(el('p', `Operator-configured instance: ${board.connector_instance || 'Not configured'}`, 'help'));
  fields.append(el('p', `Existing approval: ${board.integration.instance || 'None'}`, 'help'));
  const input = field(fields, 'projects', 'Approved numeric GitLab project IDs · comma separated', board.integration.projects.join(', ')); input.maxLength = 1800;
  fields.append(el('p', 'Every workspace member, including viewers and authorized machine readers, can see engineering metadata from these projects. Revoking a project or changing the instance removes its links and cached observations; cards and audit remain. Empty IDs disable the integration.', 'help'));
  const consent = field(fields, 'consent', 'I approve this metadata visibility and any removals', 'yes', 'checkbox'); consent.required = true;
  if (!board.connector_instance) fields.append(el('p', 'Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN. Planning works without a connector.', 'help'));
 }, data => {
  const raw = data.get('projects').trim(); const parts = raw ? raw.split(',').map(v => v.trim()) : [];
  if (parts.some(v => !/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v)))) throw new Error('Use positive numeric GitLab project IDs.');
  return {kind:'integration.save', integration:{instance:board.connector_instance, projects:parts.map(Number)}};
 }, board.role !== 'admin');
}
function showLinks(item) {
 const ready = board.connector_instance && board.connector_instance === board.integration.instance;
 openEditor('Linked GitLab observations', fields => {
  fields.append(el('p', `${item.title} · ${board.integration.instance || 'No approved integration'}`, 'help'));
  fields.append(el('p', `Engineering observations only. Refresh does not move cards or change sprint scope. ${board.refresh_seconds ? `Background refresh: about every ${board.refresh_seconds} seconds, with backoff on failures. Webhook hints can request an earlier refresh.` : 'Automatic refresh is disabled; use manual refresh.'} Observations older than five minutes or awaiting refresh are stale. This dialog is a snapshot; reopen to see background results.`, 'help'));
  const links = board.links.filter(l => l.items.includes(item.id));
  if (!links.length) fields.append(el('p', 'Unlinked. Add an approved MR or a pinned pipeline; never infer links from card titles.', 'empty'));
  links.forEach(link => {
   const row = el('article', undefined, 'setup-row'); const obs = link.observation;
   row.append(observationSummary('strong', link));
   if (obs?.title) row.append(el('p', obs.title));
   if (obs?.mr_state) row.append(el('p', `${obs.draft ? 'Draft · ' : ''}Review/mergeability: ${obs.review || 'unknown'} · Head SHA ${obs.head_sha || 'unknown'}`, 'help'));
   if (obs?.pipeline) row.append(el('p', `Pipeline #${obs.pipeline.id} · SHA ${obs.pipeline.sha || 'unknown'} · Provider state ${obs.pipeline.provider_state || 'unknown'}`, 'help'));
   const outcomes = {unobserved:'Not refreshed',ok:'Last attempt succeeded',inaccessible:'GitLab denied access',not_found:'Not found or hidden by GitLab',unavailable:'GitLab unavailable',invalid_response:'Invalid GitLab response',rate_limited:'GitLab rate limited',busy:'Connector busy',disabled:'Connector disabled',outdated:'Older provider version ignored; cached data retained',refreshing:'Refresh requested; retry after cooldown if interrupted'};
   row.append(el('p', outcomes[link.outcome] || 'Unknown outcome', 'help'));
   row.append(el('p', `Last success: ${link.last_success ? new Date(link.last_success).toLocaleString() : 'Never'} · Last attempt: ${link.last_attempt ? new Date(link.last_attempt).toLocaleString() : 'Never'}`, 'help'));
   if (obs?.url) { const a = el('a', 'Open in GitLab'); a.href = obs.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; row.append(a); }
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
   if (!item.archived) actions.append(writeButton('Unlink…', () => { $('editor').close(); openEditor('Unlink engineering object', f => f.append(el('p', 'Remove this link from this item? Other attached items retain it. Removing its last attachment also removes its cached observation; audit is retained.')), () => ({kind:'link.detach', target:item.id, destination:link.id})); }));
   row.append(actions); fields.append(row);
  });
  if (!ready) fields.append(el('p', 'Connector unavailable or instance approval needs updating. An admin can review Integration settings.', 'help'));
  if (!item.archived) {
   const add = writeButton('＋ Link MR or pipeline', () => {
    $('editor').close(); openEditor('Link engineering object', f => {
     field(f, 'project', 'Approved GitLab project', '', 'text', board.integration.projects.map(id => [String(id), String(id)]));
     field(f, 'kind', 'Object kind', 'mr', 'text', [['mr','Merge request'],['pipeline','Pinned pipeline']]);
     const number = field(f, 'number', 'MR IID or pipeline ID', '', 'number'); number.min = 1; number.max = Number.MAX_SAFE_INTEGER; number.required = true; number.step = 1;
     f.append(el('p', 'Use numeric coordinates from the approved instance. Pipeline links stay pinned to that ID; MR links follow its head pipeline. Adding a link does not fetch it automatically.', 'help'));
    }, data => ({kind:'link.attach', target:item.id, link:{project:Number(data.get('project')), kind:data.get('kind'), number:Number(data.get('number'))}}));
   }, 'primary'); add.disabled ||= !ready || !board.integration.projects.length; fields.append(add);
  }
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
$('editor').addEventListener('cancel', e => { if (busy) e.preventDefault(); });
$('dismiss').onclick = $('cancel').onclick = () => { if (!busy) $('editor').close(); };
$('projects').onclick = manageProjects;
$('proposals').onclick = () => showProposals();
$('labels').onclick = manageLabels; $('members').onclick = manageMembers; $('integration').onclick = editIntegration;
$('new-item').onclick = () => editItem(); $('columns').onclick = setupBoard; $('refresh').onclick = refresh;
$('scope').onchange = $('project').onchange = $('label').onchange = $('search').oninput = renderContent;
document.querySelectorAll('[data-view]').forEach(b => { b.onclick = async () => { if (loading || busy) return; view = b.dataset.view; if (view === 'history') { try { await loadHistory(true); } catch (e) { notice(e.message, true); } } render(); }; });
async function chooseWorkspace() {
 board = undefined; $('project').value = 'all'; $('label').value = 'all'; $('scope').value = 'all'; $('search').value = ''; render();
 root = `/api/v2/workspaces/${encodeURIComponent($('workspace').value)}`;
 await refresh();
}
$('workspace').onchange = chooseWorkspace;
let observationPoll = false;
setInterval(async () => {
 if (!board?.refresh_seconds || busy || loading || drag || document.hidden || $('editor').open || observationPoll) return;
 const current = board, path = root; observationPoll = true;
 try {
  const next = await api(path + '/board');
  if (board !== current || root !== path || busy || loading || drag || $('editor').open) return;
  if (next.workspace.revision !== board.workspace.revision || next.role !== board.role) { notice('Planning or permissions changed elsewhere. Use Refresh to review.'); return; }
  board.links = next.links;
  document.querySelectorAll('[data-observation]').forEach(node => { const link = board.links.find(l => l.id === node.dataset.observation); if (link) node.textContent = linkSummary(link); });
 } catch (e) { if (board === current && !busy && !$('editor').open) notice('Observation cache could not be reloaded. Use Refresh to retry.', true); }
 finally { observationPoll = false; }
}, 15000);
// Local freshness/cooldowns require no additional network requests.
setInterval(() => {
 if (!board) return;
 document.querySelectorAll('[data-observation]').forEach(node => { const link = board.links.find(l => l.id === node.dataset.observation); if (link) node.textContent = linkSummary(link); });
 document.querySelectorAll('[data-refresh-link]').forEach(node => { const link = board.links.find(l => l.id === node.dataset.refreshLink); node.disabled = !writable() || !link || !board.connector_instance || board.connector_instance !== board.integration.instance || !!link.next_refresh && Date.parse(link.next_refresh) > Date.now(); });
}, 10000);
renderControls();
(async () => { try { session = await api('/api/v2/session'); $('identity').textContent = session.name || session.subject; $('mode').textContent = session.demo ? 'LOCAL DEMO · synthetic login' : 'Native planning'; workspaces = await api('/api/v2/workspaces'); options($('workspace'), workspaces.map(w => [w.id, w.name])); if (!workspaces.length) { notice('No workspace membership. Ask an operator to grant your login subject access: ' + session.subject); render(); return; } await chooseWorkspace(); } catch (e) { notice(e.message, true); renderControls(); } })();
