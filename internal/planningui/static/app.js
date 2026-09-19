// Flux planning shell. Loaded as an ES module, so strict mode is implicit.
import {$, el, button, options, svgNode, syncAttributes, field} from './modules/dom.js';
import {api, apiRevalidated, requestKey} from './modules/api.js';
// Board reads are revalidated against the copy already in memory, so a refresh
// that finds nothing new transfers no payload. The ETag is scoped to the root
// it was issued for and discarded whenever the workspace changes.
let boardETag = '', boardETagRoot = '';
import {initials, attachmentSize, attachmentKind, attachmentTypeDescription, labelForeground, burndownDateLabel, workspaceLabel, workspaceHistoryLabel, columnWIPLabel} from './modules/format.js';
import {renderMarkdown, markdownEditor} from './modules/markdown.js';

let session, workspaces = [], board, root, view = 'board', presentation = 'board', busy = false, loading = false, planningChangeNotice = false;
let workspaceGate = 'loading', workspaceCreating = false, workspaceCreateKey = '', workspaceCreateName = '', membershipPoll = false;
let pendingPlanningURLState;
let projectSearch = '', projectAssigneeFilter = 'all', projectLabelFilter = 'all';
let selectedItemID = '', detailPane, detailState;
let attachmentTooltip, attachmentTooltipTarget, observationTooltipTarget;
let history = [], historyBefore = 0, historyMore = false, loadGeneration = 0;
// Archived work is paged from its own endpoint; the board payload carries only
// the live working set plus archived items still referenced by scope or dependencies.
let archiveItems = [], archiveOffset = 0, archiveMore = false;
let integrationFormOpen = false, integrationCatalog = [], integrationCatalogLoaded = false, integrationCatalogError = '', integrationCatalogLoading = false, integrationCatalogRequest = 0;
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
function updateThemeControl() { const dark = document.documentElement.dataset.theme === 'dark'; $('theme').firstElementChild.textContent = dark ? '☀' : '☾'; $('theme').title = dark ? 'Switch to light theme' : 'Switch to dark theme'; }
$('theme').onclick = () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; localStorage.setItem('flux-plan-theme', next); updateThemeControl(); };
updateThemeControl();
function actionIconButton(label, icon, fn, className) { const b = button('', fn, `action-icon${className ? ` ${className}` : ''}`); b.dataset.icon = icon; b.dataset.actionLabel = label; b.setAttribute('aria-label', label); b.title = label; return b; }
function writeIconButton(label, icon, fn, className) { const b = actionIconButton(label, icon, fn, className); b.dataset.write = 'true'; b.disabled = !writable() || integrationFormOpen; return b; }
function adminIconButton(label, icon, fn, className) { const b = actionIconButton(label, icon, fn, className); b.dataset.adminWrite = 'true'; b.disabled = !adminWritable() || integrationFormOpen; return b; }
function writable() { return board && board.role !== 'viewer' && !busy && !loading; }
function adminWritable() { return board && board.role === 'admin' && !busy && !loading; }
function gitLabWritable() { return writable() && !!board.connector_instance && board.connector_instance === board.integration.instance && !!board.integration.projects.length; }
function canComment() { return board && (board.role === 'member' || board.role === 'admin') && !busy && !loading; }
function writeButton(text, fn, className) { const b = button(text, fn, className); b.disabled = !writable() || integrationFormOpen; return b; }
function adminButton(text, fn, className) { const b = button(text, fn, className); b.dataset.adminWrite = 'true'; b.disabled = !adminWritable() || integrationFormOpen; return b; }
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
function showPlanningChangeNotice(text = 'Planning changed elsewhere · Refresh to review') { const banner = $('planning-change'); if (planningChangeNotice && !banner.hidden && $('planning-change-text').textContent === text) return; planningChangeNotice = true; $('planning-change-text').textContent = text; banner.hidden = false; }
function clearPlanningChangeNotice() { planningChangeNotice = false; $('planning-change').hidden = true; }
function workspaceURLState() { return new URL(window.location.href).searchParams.get('workspace') || ''; }
function workspacePreference() { return workspaceURLState() || localStorage.getItem('flux-plan-workspace') || ''; }
function persistWorkspaceURL(id) {
 const url = new URL(window.location.href);
 if (id) { url.searchParams.set('workspace', id); localStorage.setItem('flux-plan-workspace', id); }
 else { url.searchParams.delete('workspace'); localStorage.removeItem('flux-plan-workspace'); }
 window.history.replaceState(null, '', url);
}
function validWorkspaceList(data) { return Array.isArray(data) && data.every(workspace => workspace && typeof workspace.id === 'string' && workspace.id && typeof workspace.name === 'string' && workspace.name && typeof workspace.role === 'string' && Number.isSafeInteger(workspace.revision)); }
function workspaceListSignature(list) { return JSON.stringify(list.map(workspace => [workspace.id, workspace.name, workspace.role, workspace.revision])); }
function updateWorkspaceOptions(selected = '') {
 const signature = workspaceListSignature(workspaces); const select = $('workspace');
 if (select.dataset.signature === signature && select.value === selected) return;
 options(select, workspaces.map(workspace => [workspace.id, workspaceLabel(workspace)]), selected);
 select.dataset.signature = signature;
}
async function loadWorkspaces(selected = '') {
 const next = await api('/api/v2/workspaces');
 if (!validWorkspaceList(next)) throw new Error('Workspace list is invalid. Refresh to retry.');
 workspaces = next; updateWorkspaceOptions(selected && workspaces.some(workspace => workspace.id === selected) ? selected : ''); return next;
}
function planningURLState() {
 const params = new URLSearchParams(window.location.search); const mode = params.get('mode');
 return {mode: mode === 'list' || mode === 'board' ? mode : undefined, project: params.get('project') || undefined, scope: params.get('scope') || undefined};
}
function persistPlanningURL() {
 if (!board) return; const url = new URL(window.location.href); url.searchParams.set('mode', presentation); url.searchParams.set('project', $('project').value || 'all'); url.searchParams.set('scope', $('scope').value || 'active'); window.history.replaceState(null, '', url);
}
function applyPlanningURLState(state = planningURLState()) {
 if (!board) return;
 const project = state.project && (state.project === 'all' || state.project === 'none' || board.projects.some(value => value.id === state.project)) ? state.project : 'all'; presentation = state.mode === 'list' || (!state.mode && project !== 'all' && project !== 'none') ? 'list' : 'board'; $('project').value = project;
 const requestedScope = state.scope; const validScope = requestedScope && (['active', 'backlog', 'all'].includes(requestedScope) || board.sprints.some(value => value.id === requestedScope)); $('scope').value = validScope ? requestedScope : project !== 'all' && project !== 'none' ? 'all' : 'active';
 render(); persistPlanningURL();
}
pendingPlanningURLState = planningURLState();
function mergeEntities(previous = [], next = [], key) {
 const existing = new Map(previous.map(value => [key(value), value]));
 return next.map(value => { const current = existing.get(key(value)); if (!current) return value; Object.keys(current).forEach(name => { if (!(name in value)) delete current[name]; }); Object.assign(current, value); return current; });
}
function mergeBoardData(previous, next) {
 if (!previous) return next;
 return {...next,
  projects: mergeEntities(previous.projects, next.projects, value => value.id),
  labels: mergeEntities(previous.labels, next.labels, value => value.name),
  columns: mergeEntities(previous.columns, next.columns, value => value.id),
  items: mergeEntities(previous.items, next.items, value => value.id),
  sprints: mergeEntities(previous.sprints, next.sprints, value => value.id),
  members: mergeEntities(previous.members, next.members, value => value.subject),
  links: mergeEntities(previous.links, next.links, value => value.id),
 };
}
function captureUIState() {
 const active = document.activeElement;
 const focus = active && active !== document.body && active !== document.documentElement ? {node:active, id:active.id, key:active.dataset?.focusKey} : undefined;
 const selection = active && 'selectionStart' in active && Number.isFinite(active.selectionStart) ? {start:active.selectionStart, end:active.selectionEnd, direction:active.selectionDirection} : undefined;
 const scrollNodes = [document.querySelector('main'), $('content'), detailPane, detailState?.form?.querySelector('.item-detail-fields'), $('editor'), $('editor-form')?.querySelector('#fields')].filter((node, index, values) => node && values.indexOf(node) === index);
 const details = [...document.querySelectorAll('details')].map((node, index) => ({node, key:node.dataset.stateKey || `details:${index}`, open:node.open}));
 return {focus, selection, scrollX:window.scrollX, scrollY:window.scrollY, scrollNodes:scrollNodes.map(node => ({node, left:node.scrollLeft, top:node.scrollTop})), details};
}
function restoreUIState(state) {
 if (!state) return;
 state.scrollNodes.forEach(({node, left, top}) => { if (node?.isConnected) { node.scrollLeft = left; node.scrollTop = top; } });
 state.details.forEach(({node, key, open}) => { const target = node?.isConnected ? node : [...document.querySelectorAll('details')].find(candidate => candidate.dataset.stateKey === key); if (target) target.open = open; });
 window.scrollTo(state.scrollX, state.scrollY);
 let target = state.focus?.node?.isConnected ? state.focus.node : undefined;
 if (!target && state.focus?.id) target = $(state.focus.id);
 if (!target && state.focus?.key) target = [...document.querySelectorAll('[data-focus-key]')].find(candidate => candidate.dataset.focusKey === state.focus.key);
 if (!target) return;
 try { target.focus({preventScroll:true}); } catch { target.focus(); }
 if (state.selection && 'selectionStart' in target) { try { target.setSelectionRange(state.selection.start, state.selection.end, state.selection.direction); } catch {} }
}
function resetBurndown() { burndownGeneration++; burndownData.clear(); burndownRequests.clear(); burndownErrors.clear(); }
function enterWorkspaceGate(mode, message) {
 if (detailState) closeDetail({force:true, focus:false});
 if ($('editor').open && !busy) closeEditor();
 board = undefined; root = undefined; boardETag = ''; boardETagRoot = ''; workspaceGate = mode; pendingPlanningURLState = undefined; persistWorkspaceURL('');
 if (message) notice(message);
 render();
}
async function refreshWorkspaceGate() {
 if (busy || loading || integrationFormOpen) return false;
 const generation = ++loadGeneration; loading = true; renderControls(); $('content').setAttribute('aria-busy', 'true');
 try {
  const next = await loadWorkspaces(''); if (generation !== loadGeneration) return false;
  if (next.length === 1) { loading = false; return await chooseWorkspace(next[0].id); }
  workspaceGate = next.length ? 'select' : 'create';
  if (!next.length) persistWorkspaceURL('');
  notice(next.length ? 'Choose a workspace to continue.' : 'No workspace yet. Create one to get started.'); return true;
 } catch (e) { if (generation === loadGeneration) notice(e.message, true); return false; }
 finally { if (generation === loadGeneration) { loading = false; render(); } }
}
async function refresh() {
 if (busy || integrationFormOpen) return false;
 if (!root) return refreshWorkspaceGate();
 const generation = ++loadGeneration; let uiState; loading = true; renderControls(); $('content').setAttribute('aria-busy', 'true');
 try {
  const selectedID = board?.workspace?.id || $('workspace').value;
  const memberships = await loadWorkspaces(selectedID); if (generation !== loadGeneration) return false;
  if (!selectedID || !memberships.some(workspace => workspace.id === selectedID)) {
   enterWorkspaceGate(memberships.length ? 'select' : 'create', memberships.length ? 'Workspace access changed. Choose an available workspace.' : 'Workspace access changed. Create a workspace to get started.');
   return false;
  }
  const cached = board && boardETagRoot === root ? boardETag : '';
  const response = await apiRevalidated(root + '/board', cached); if (generation !== loadGeneration) return false;
  boardETag = response.etag; boardETagRoot = root;
  if (!response.modified) { clearPlanningChangeNotice(); notice(`Up to date · workspace revision ${board.workspace.revision}`); return true; }
  const next = response.data;
  uiState = captureUIState(); board = mergeBoardData(board, next); workspaceGate = ''; persistWorkspaceURL(board.workspace.id); clearPlanningChangeNotice(); resetBurndown(); history = []; historyBefore = 0; resetArchive(); observationDigest = ''; observationReadAt = 0;
  if (view === 'history') await loadHistory(true); if (view === 'archive') await loadArchive(true); notice(`Up to date · workspace revision ${board.workspace.revision}`); return true;
 } catch (e) { if (generation === loadGeneration) notice(e.message, true); return false; }
 finally { if (generation === loadGeneration) { loading = false; render(); restoreUIState(uiState || captureUIState()); if (!burndownRequests.size) $('content').setAttribute('aria-busy', 'false'); } }
}
async function change(command, key = requestKey()) {
 if (!writable()) throw new Error('Planning is read-only or a request is in progress.');
 busy = true; renderControls(); notice('Saving changes…');
 try { await api(root + '/changes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf, 'Idempotency-Key': key }, body: JSON.stringify(command) }); }
 finally { busy = false; renderControls(); }
 const refreshed = await refresh(); notice(refreshed ? 'Changes saved.' : 'Changes saved, but refreshing failed. Use Refresh before continuing.', !refreshed);
}
async function quick(command) { try { await change({ revision: board.workspace.revision, ...command }); } catch (e) { notice(e.message, true); render(); } }
function renderControls() { document.querySelectorAll('[data-write]').forEach(b => { b.disabled = !writable() || integrationFormOpen; }); document.querySelectorAll('[data-admin-write]').forEach(b => { b.disabled = !adminWritable() || integrationFormOpen; }); document.querySelectorAll('[data-gitlab-write]').forEach(b => { b.disabled = !gitLabWritable(); }); document.querySelectorAll('[data-comment-write]').forEach(b => { b.disabled = !canComment(); }); document.querySelectorAll('[data-drag-type]').forEach(e => { const item = e.dataset.dragType === 'card' ? findItem(e.dataset.item) : undefined; e.draggable = writable() && !item?.archived; }); document.querySelectorAll('[data-view]').forEach(b => { b.disabled = busy || loading || integrationFormOpen; }); $('presentation-toggle').hidden = !board || view !== 'board'; $('presentation-board').disabled = !board || busy || loading || integrationFormOpen; $('presentation-list').disabled = !board || busy || loading || integrationFormOpen; $('presentation-board').setAttribute('aria-pressed', String(presentation === 'board')); $('presentation-list').setAttribute('aria-pressed', String(presentation === 'list')); $('refresh').disabled = busy || loading || integrationFormOpen; $('planning-refresh').disabled = busy || loading || integrationFormOpen; $('new-workspace').disabled = !session || busy || loading || integrationFormOpen; $('workspace-field').hidden = !board && workspaceGate !== 'loading'; $('workspace').disabled = !board || busy || loading || integrationFormOpen; document.querySelector('nav').hidden = !board; document.querySelector('.heading .actions').hidden = !board; document.querySelector('.toolbar').hidden = !board; $('project').disabled = !board || busy || loading; $('assignee').disabled = !board || busy || loading; $('label').disabled = !board || busy || loading; }
let drag;
function isFileTransfer(dataTransfer) { return Array.from(dataTransfer?.types || []).includes('Files'); }
document.addEventListener('dragover', e => { if (isFileTransfer(e.dataTransfer)) e.preventDefault(); });
document.addEventListener('drop', e => { if (isFileTransfer(e.dataTransfer)) e.preventDefault(); });
function clearDropMarks() { document.querySelectorAll('.drop-before,.drop-after,.drop-end').forEach(e => e.classList.remove('drop-before', 'drop-after', 'drop-end')); }
function makeDraggable(node, type, id, name) {
 node.dataset.dragType = type; node.draggable = writable() && !(type === 'card' && findItem(id)?.archived); node.setAttribute('aria-label', `Drag ${type} ${name}`);
 node.addEventListener('dragstart', e => {
  if (!writable() || (type === 'card' && findItem(id)?.archived) || (e.target !== node && e.target.closest?.('button,a,input,select,textarea'))) { e.preventDefault(); return; }
  e.stopPropagation(); drag = {type, id, revision: board.workspace.revision, root}; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id);
 });
 node.addEventListener('dragend', () => { drag = undefined; clearDropMarks(); });
 return node;
}
function dropZone(node, type, command, axis = 'y') {
 function accepts() { return drag?.type === type && drag.root === root && writable() && !(type === 'card' && findItem(node.dataset.item)?.archived); }
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
function memberListingInfo(member) {
 const name = String(member.name || '').trim() || (member.subject === session?.subject && String(session.name || '').trim()) || String(member.username || '').trim() || 'Unnamed member';
 return {name, avatarURL: member.avatar_url || (member.subject === session?.subject && session.avatar_url) || ''};
}
function avatarView(name, avatarURL) {
 const avatar = el('span', undefined, 'avatar'); avatar.setAttribute('aria-hidden', 'true'); avatar.append(el('span', initials(name), 'avatar-fallback'));
 if (avatarURL) { const image = el('img'); image.src = avatarURL; image.alt = ''; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.onerror = () => image.remove(); avatar.append(image); }
 return avatar;
}
function assigneeView(subject) {
 const info = memberInfo(subject); const node = el('span', undefined, 'assignee'); node.setAttribute('aria-label', `Assignee: ${info.name}`); node.title = info.name;
 node.append(avatarView(info.name, info.avatarURL), el('span', info.name)); return node;
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
function cardLinkView(link, focusKey) {
 const url = link.kind === 'mr' ? mergeRequestLinkURL(link) : link.observation?.url; const node = el(url ? 'a' : 'span', linkLabel(link), 'card-link');
 node.dataset.linkId = link.id; node.dataset.observation = 'link'; node.dataset.focusKey = focusKey || `link:${link.id}`;
 node.title = link.observation?.title || linkDisplayName(link, false);
 if (url) { node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
 return node;
}
function attachmentHref(item, attachment, base = root) {
 return `${base}/items/${encodeURIComponent(item.id)}/attachments/${encodeURIComponent(attachment.id)}`;
}
// A board read reports how many attachments a card has, not what they are, so
// metadata is fetched per card the first time it is actually shown. An item
// whose list has been loaded keeps it on the board item itself; merging a
// fresh board drops that field and the next viewer reloads it.
const attachmentLoads = new Map(), attachmentListeners = new Set();
function attachmentsLoaded(item) { return Array.isArray(item?.attachments); }
function attachmentCount(item) { return attachmentsLoaded(item) ? item.attachments.length : Number.isSafeInteger(item?.attachment_count) && item.attachment_count > 0 ? item.attachment_count : 0; }
function setItemAttachments(item, attachments) {
 const target = board?.items.find(value => value.id === item.id) || item;
 target.attachments = attachments; target.attachment_count = attachments.length;
 if (target !== item) { item.attachments = attachments; item.attachment_count = attachments.length; }
 attachmentListeners.forEach(listener => listener(item.id));
}
function ensureAttachments(item) {
 if (!item || !root || attachmentsLoaded(item)) return attachmentLoads.get(item?.id);
 if (attachmentLoads.has(item.id)) return attachmentLoads.get(item.id);
 const currentBoard = board, currentRoot = root, id = item.id;
 const pending = (async () => {
  try {
   const data = await api(`${currentRoot}/items/${encodeURIComponent(id)}/attachments`);
   if (board !== currentBoard || root !== currentRoot) return;
   if (!validAttachments(data) || data.some(attachment => attachment.item_id !== id)) throw new Error('Attachment list is invalid. Refresh to retry.');
   setItemAttachments(item, data); renderContent();
  } catch (error) { if (board === currentBoard && root === currentRoot) notice(error.message, true); }
  finally { attachmentLoads.delete(id); }
 })();
 attachmentLoads.set(id, pending); return pending;
}
function attachmentFileMark(attachment) {
 const mark = el('span', attachmentKind(attachment), 'attachment-file-mark'); mark.setAttribute('aria-hidden', 'true'); return mark;
}
function attachmentPaperclip() { const icon = el('span', '📎', 'attachment-paperclip'); icon.setAttribute('aria-hidden', 'true'); return icon; }
function attachmentLinkView(item, attachment, base = root) {
 const link = el('a', attachment.name, 'attachment-link'); link.href = attachmentHref(item, attachment, base);
 link.setAttribute('aria-label', attachment.name); link.setAttribute('download', ''); link.dataset.attachmentTooltip = attachmentTypeDescription(attachment); return link;
}
function attachmentTileLink(item, attachment, base = root, metadata = attachmentSize(attachment.size)) {
 const link = attachmentLinkView(item, attachment, base); link.dataset.attachmentId = String(attachment.id); link.classList.add('attachment-tile-link');
 const copy = el('span', undefined, 'attachment-tile-copy'); copy.append(el('span', attachment.name, 'attachment-name'), el('span', metadata, 'attachment-meta')); link.replaceChildren(attachmentFileMark(attachment), copy); return link;
}
function attachmentTooltipHost() { return document.querySelector('dialog[open]') || document.body; }
function ensureAttachmentTooltip() {
 if (attachmentTooltip) return attachmentTooltip;
 attachmentTooltip = el('span', undefined, 'attachment-tooltip'); attachmentTooltip.id = 'attachment-tooltip'; attachmentTooltip.setAttribute('role', 'tooltip'); attachmentTooltip.hidden = true; return attachmentTooltip;
}
function attachmentLinkTarget(target) { return target instanceof Element ? target.closest('.attachment-tile-link') : undefined; }
function attachmentTooltipAnchor(target, source) {
 const mark = (source instanceof Element ? source.closest('.attachment-file-mark') : undefined) || target.querySelector('.attachment-file-mark'); return mark && target.contains(mark) ? mark : target;
}
function hideAttachmentTooltip(target) {
 if (target && target !== attachmentTooltipTarget) return;
 if (attachmentTooltipTarget?.getAttribute('aria-describedby') === 'attachment-tooltip') attachmentTooltipTarget.removeAttribute('aria-describedby');
 attachmentTooltipTarget = undefined; if (attachmentTooltip) attachmentTooltip.hidden = true;
}
function showAttachmentTooltip(target, source) {
 if (!target?.dataset.attachmentTooltip) { hideAttachmentTooltip(); return; }
 if (attachmentTooltipTarget && attachmentTooltipTarget !== target) hideAttachmentTooltip();
 const tooltip = ensureAttachmentTooltip(); const host = attachmentTooltipHost(); if (tooltip.parentElement !== host) host.append(tooltip);
 attachmentTooltipTarget = target; tooltip.textContent = target.dataset.attachmentTooltip; target.setAttribute('aria-describedby', tooltip.id); tooltip.hidden = false;
 const rootStyle = getComputedStyle(document.documentElement); const gap = Number.parseFloat(rootStyle.getPropertyValue('--s1')) || 4; const edge = Number.parseFloat(rootStyle.getPropertyValue('--s4')) || 16; const targetBox = target.getBoundingClientRect(); const anchor = attachmentTooltipAnchor(target, source).getBoundingClientRect(); const size = tooltip.getBoundingClientRect();
 const maxLeft = Math.max(edge, innerWidth - size.width - edge); const left = Math.min(Math.max(edge, anchor.left), maxLeft); const top = Math.min(Math.max(edge, targetBox.bottom + gap), Math.max(edge, innerHeight - size.height - edge)); tooltip.style.left = `${Math.round(left)}px`; tooltip.style.top = `${Math.round(top)}px`;
}
function repositionAttachmentTooltip() { const dialog = attachmentTooltipTarget?.closest('dialog'); if (attachmentTooltipTarget?.isConnected && (!dialog || dialog.open)) showAttachmentTooltip(attachmentTooltipTarget); else hideAttachmentTooltip(); }
function attachmentTile(item, attachment, base, metadata, onRemove) {
 const tile = el('div', undefined, 'attachment-tile'); tile.dataset.attachmentId = String(attachment.id); tile.dataset.renderSignature = JSON.stringify({attachment, metadata}); tile.append(attachmentTileLink(item, attachment, base, metadata));
 if (onRemove) {
  const actions = el('details', undefined, 'attachment-actions'); actions.dataset.stateKey = `attachment:${attachment.id}:actions`; const toggle = el('summary', '⋯', 'attachment-actions-toggle'); toggle.setAttribute('aria-label', `Attachment actions for ${attachment.name}`); toggle.title = 'Attachment actions';
  const menu = el('div', undefined, 'attachment-actions-menu'); menu.setAttribute('role', 'menu'); const remove = button('Remove attachment', onRemove, 'attachment-remove'); remove.setAttribute('role', 'menuitem'); remove.dataset.write = 'true'; menu.append(remove); actions.append(toggle, menu); tile.append(actions);
 }
 return tile;
}
function validAttachments(data) {
 return Array.isArray(data) && data.every(attachment => attachment && Number.isSafeInteger(attachment.id) &&
  attachment.id > 0 && typeof attachment.item_id === 'string' && typeof attachment.name === 'string' &&
  attachment.name && typeof attachment.content_type === 'string' && attachment.content_type &&
  typeof attachment.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(attachment.digest) &&
  Number.isSafeInteger(attachment.size) && attachment.size >= 0 && typeof attachment.uploader === 'string' &&
  attachment.uploader && typeof attachment.created_at === 'string' && !Number.isNaN(Date.parse(attachment.created_at)));
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
function itemProjectIDs(item) {
 if (Array.isArray(item?.project_ids)) return item.project_ids.filter(Boolean).map(String);
 return item?.project_id ? [String(item.project_id)] : [];
}
function projectBadges(item, className = 'card-project') {
 const names = itemProjectIDs(item).map(projectName); if (!names.length) names.push('No project');
 return names.map(name => el('span', name, `badge ${className}`));
}
function labelInfo(name) { return board.labels.find(label => label.name === name) || {name, color: '#dcefe4'}; }
function renderProjectSummary() {
 const summary = $('project-summary'); const projectID = $('project').value; const project = board.projects.find(value => value.id === projectID);
 if (view !== 'board' || !project || ['all', 'none'].includes(projectID)) { summary.hidden = true; summary.replaceChildren(); return; }
 const items = board.items.filter(item => !item.archived && itemProjectIDs(item).includes(projectID)); const openSprints = board.sprints.filter(sprint => sprint.state !== 'closed' && items.some(item => item.sprint_ids.includes(sprint.id))); const active = openSprints.filter(sprint => sprint.state === 'active'); const completed = items.filter(done).length; const blockedCount = items.filter(blocked).length; const unscheduled = items.filter(item => !done(item) && !item.sprint_ids.length).length;
 const head = el('div', undefined, 'project-summary-head'); const intro = el('div', undefined, 'project-summary-title'); intro.append(el('p', 'PROJECT LENS', 'eyebrow'), el('h2', `${project.name} project`), el('p', 'Current work only · archived history is excluded.', 'help')); head.append(intro);
 const metrics = el('div', undefined, 'metrics project-summary-metrics'); [[items.length, 'In scope'], [completed, 'Done'], [blockedCount, 'Blocked'], [unscheduled, 'Unscheduled']].forEach(([value, label]) => { const metric = el('span', undefined, 'metric'); metric.append(el('strong', String(value)), el('span', label)); metrics.append(metric); });
 const coverage = el('div', undefined, 'project-sprint-coverage'); coverage.append(el('span', 'Active sprint coverage', 'project-sprint-coverage-label')); active.forEach(sprint => { const count = items.filter(item => item.sprint_ids.includes(sprint.id)).length; coverage.append(el('span', `${sprint.name} · ${count}`, 'badge')); }); if (unscheduled) coverage.append(el('span', `Backlog · ${unscheduled}`, 'badge')); if (!active.length && !unscheduled) coverage.append(el('span', 'None', 'muted'));
 summary.hidden = false; summary.setAttribute('aria-label', `${project.name} project summary`); summary.replaceChildren(head, metrics, coverage);
}
function labelBadge(name) { const label = labelInfo(name); const badge = el('span', name, 'badge label-badge'); badge.dataset.label = name; badge.style.backgroundColor = label.color; badge.style.color = labelForeground(label.color); return badge; }
function styleLabelOptions(select) { [...select.options].forEach(option => { const label = labelInfo(option.value); option.style.backgroundColor = label.color; option.style.color = labelForeground(label.color); }); }
function done(item) { return board.columns.find(c => c.id === item.column_id)?.category === 'done'; }
// Dependency targets may be archived, so resolution spans the board payload and
// the loaded archive page.
function findItem(id) { return board?.items.find(value => value.id === id) || archiveItems.find(value => value.id === id); }
function blocked(item) { return item.dependencies.some(id => { const dep = findItem(id); return dep && !done(dep); }); }
function scopeItems(sprint) { return sprint.state === 'closed' ? board.items.filter(i => board.closed_scope.some(s => s.sprint_id === sprint.id && s.item_id === i.id)) : board.items.filter(i => !i.archived && i.sprint_ids.includes(sprint.id)); }
function sprintPanel(s, items = scopeItems(s)) {
 const panel = el('article', undefined, 'sprint-panel'); panel.dataset.sprintId = s.id; const info = el('div', undefined, 'sprint-info'); const titleRow = el('div', undefined, 'sprint-title-row'); const titleCopy = el('div', undefined, 'sprint-title-copy'); titleCopy.append(el('p', `${s.state.toUpperCase()} SPRINT`, 'eyebrow'), el('h2', s.name)); titleRow.append(titleCopy); info.append(titleRow, el('p', s.goal), el('small', `${s.start} → ${s.end}`, 'muted'));
 const metrics = el('div', undefined, 'metrics');
 for (const [n, label] of [[items.length, 'In scope'], [items.filter(done).length, s.state === 'closed' ? 'Done now' : 'Done'], [items.filter(blocked).length, 'Blocked']]) { const metric = el('span', undefined, 'metric'); metric.append(el('strong', String(n)), el('span', label)); metrics.append(metric); }
 const actions = el('div', undefined, 'actions sprint-actions');
 const expanded = burndownExpanded.has(s.id); const toggle = actionIconButton(expanded ? 'Hide burn down' : 'Show burn down', '▥', () => { if (expanded) burndownExpanded.delete(s.id); else burndownExpanded.add(s.id); render(); [...document.querySelectorAll('[data-burndown-toggle]')].find(element => element.dataset.burndownToggle === s.id)?.focus(); }, 'quiet'); toggle.dataset.burndownToggle = s.id; toggle.setAttribute('aria-expanded', String(expanded)); if (expanded) toggle.setAttribute('aria-controls', `burndown-${s.id}`); toggle.disabled = busy || loading; actions.append(toggle);
 actions.append(actionIconButton('View scope', '◎', () => { view = 'board'; $('scope').value = s.id; render(); persistPlanningURL(); }));
 if (s.state !== 'closed') actions.append(writeIconButton('Edit sprint', '✎', () => editSprint(s)));
 if (s.state === 'planned') actions.append(writeIconButton('Start sprint', '▶', () => quick({ kind: 'sprint.start', target: s.id }), 'primary'));
 if (s.state === 'active') actions.append(writeIconButton('Close sprint', '■', () => closeSprint(s)));
 if (s.state === 'closed') actions.append(writeIconButton('Re-open sprint', '↶', () => quick({ kind: 'sprint.reopen', target: s.id })));
 if (s.state === 'closed') info.append(el('small', 'Scope preserved at closure. Card details reflect current work; historical state is retained in audit.', 'muted'));
 panel.append(info, actions, metrics); if (expanded) panel.append(renderBurndown(s)); panel.dataset.renderSignature = JSON.stringify({s, expanded, data:expanded ? burndownData.get(currentBurndownKey(s.id)) || null : null, error:expanded ? burndownErrors.get(currentBurndownKey(s.id)) || null : null}); return panel;
}
function renderWorkspaceSelection(content) {
 const gate = el('section', undefined, 'workspace-gate'); gate.setAttribute('aria-label', 'Choose a workspace'); gate.append(el('p', 'Select the workspace you want to open. You can switch workspaces from the sidebar after entering one.', 'help'));
 const list = el('div', undefined, 'workspace-choice-list'); list.setAttribute('role', 'list'); workspaces.forEach(workspace => { const choice = button('', () => { void chooseWorkspace(workspace.id); }, 'workspace-choice'); choice.dataset.workspaceChoice = workspace.id; choice.setAttribute('aria-label', `Open ${workspace.name}`); const copy = el('span', undefined, 'workspace-choice-copy'); copy.append(el('strong', workspace.name), el('small', `${workspace.role} access`, 'muted')); choice.append(copy, el('span', 'Open →', 'workspace-choice-action')); list.append(choice); }); gate.append(list);
 const actions = el('div', undefined, 'actions workspace-gate-actions'); actions.append(button('Create a workspace', showWorkspaceCreate, 'primary')); gate.append(actions); content.replaceChildren(gate);
}
function renderWorkspaceCreation(content) {
 const gate = el('section', undefined, 'workspace-gate'); gate.setAttribute('aria-label', 'Create a workspace'); gate.append(el('p', session?.name ? `You are signed in as ${session.name}. Create a workspace to start planning; you will be its initial administrator.` : 'Create a workspace to start planning; your signed-in account will be its initial administrator.', 'help'));
 const form = el('form', undefined, 'workspace-create-form'); const input = field(form, 'name', 'Workspace name'); input.id = 'workspace-name'; input.required = true; input.maxLength = 120; input.autocomplete = 'organization'; input.placeholder = 'e.g. Team Alpha'; const status = el('p', '', 'workspace-create-status'); status.dataset.workspaceCreateStatus = 'true'; status.hidden = true; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); form.append(status); const actions = el('div', undefined, 'actions'); const submit = button('Create workspace', undefined, 'primary'); submit.type = 'submit'; actions.append(submit); if (workspaces.length) actions.append(button('Back to workspace selection', showWorkspaceSelection)); form.append(actions); form.addEventListener('submit', createWorkspace); gate.append(form); content.replaceChildren(gate); input.focus();
}
function render() {
 renderControls();
 if (!board) {
  $('content').setAttribute('aria-busy', String(workspaceGate === 'loading' || loading)); $('project-summary').hidden = true; $('project-summary').replaceChildren(); $('sprint-summary').replaceChildren(); $('count').textContent = ''; $('planning-change').hidden = true;
  if (workspaceGate === 'select') { $('title').textContent = 'Choose a workspace'; $('subtitle').textContent = 'Select a shared planning space to continue.'; renderWorkspaceSelection($('content')); }
  else if (workspaceGate === 'create') { $('title').textContent = workspaces.length ? 'Create a workspace' : 'Create your first workspace'; $('subtitle').textContent = 'Set up a shared planning space for your team.'; renderWorkspaceCreation($('content')); }
  else { $('title').textContent = 'Loading planning data'; $('subtitle').textContent = 'Checking workspace access…'; $('content').replaceChildren(el('p', 'Loading workspace access…', 'empty')); }
  return;
 }
 const projectFilter = $('project').value; options($('project'), [['all', 'All projects'], ['none', 'No project'], ...board.projects.map(p => [p.id, p.name])], projectFilter); if (!$('project').value) $('project').value = 'all';
 const assigneeFilter = $('assignee').value; options($('assignee'), [['all', 'All assignees'], ['none', 'Unassigned'], ...board.members.map(m => [m.subject, memberName(m.subject)])], assigneeFilter); if (!$('assignee').value) $('assignee').value = 'all';
 const labelFilter = $('label').value; options($('label'), [['all', 'All labels'], ['none', 'No labels'], ...board.labels.map(label => [label.name, label.name])], labelFilter); if (!$('label').value) $('label').value = 'all'; styleLabelOptions($('label'));
 const titles = { board: presentation === 'list' ? 'Planning list' : 'Kanban board', sprints: 'Sprints', projects: 'Projects', labels: 'Labels', members: 'Members', archive: 'Archive', history: 'History' };
 const subtitles = { projects: 'Organize workspace projects and GitLab integration.', labels: 'Maintain labels used to classify work.', members: 'Manage workspace members, roles, and names.' };
 $('title').textContent = titles[view]; $('subtitle').textContent = board.role === 'viewer' ? 'Read-only workspace access.' : subtitles[view] || 'Plan intentionally. Keep work moving.'; $('search').placeholder = view === 'sprints' ? 'Find sprints…' : 'Find work…';
 document.querySelectorAll('[data-view]').forEach(b => { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
 const active = activeSprints();
 const selected = $('scope').value; options($('scope'), [['active', 'Active sprints'], ['backlog', 'Backlog'], ['all', 'All open work'], ...board.sprints.map(s => [s.id, `${s.name} (${s.state})`])], selected); if (!$('scope').value) $('scope').value = 'active';
 const selectedSprint = board.sprints.find(s => s.id === $('scope').value); const summarySprints = selectedSprint?.state === 'closed' ? [selectedSprint] : active;
 $('sprint-summary').setAttribute('aria-label', selectedSprint?.state === 'closed' ? `Closed sprint: ${selectedSprint.name}` : 'Active sprints');
 renderProjectSummary(); renderSprintSummary(view === 'board' ? summarySprints : []);
 $('scope-label').hidden = view !== 'board'; $('label-filter').hidden = view === 'sprints' || view === 'history'; $('search-filter').hidden = view === 'history'; document.querySelector('.toolbar').hidden = ['history', 'projects', 'labels', 'members'].includes(view);
 renderContent();
}
function filteredItems() {
 const query = $('search').value.toLowerCase(); const scope = $('scope').value; const sprint = board.sprints.find(s => s.id === scope);
 return (view === 'archive' ? archiveItems : board.items).filter(i => {
  if (view === 'archive') { if (!i.archived) return false; } else if (i.archived && sprint?.state !== 'closed') return false;
  if (view !== 'archive') { if (scope === 'active' && !activeSprints().some(s => i.sprint_ids.includes(s.id))) return false; if (scope === 'backlog' && (i.sprint_ids.length || done(i))) return false; if (sprint && !scopeItems(sprint).some(v => v.id === i.id)) return false; }
  const project = $('project').value; const projectIDs = itemProjectIDs(i); if (project === 'none' && projectIDs.length) return false; if (project !== 'all' && project !== 'none' && !projectIDs.includes(project)) return false;
  const assignee = $('assignee').value; if (assignee === 'none' && i.assignee) return false; if (assignee !== 'all' && assignee !== 'none' && i.assignee !== assignee) return false;
  const label = $('label').value; if (label === 'none' && i.labels.length) return false; if (label !== 'all' && label !== 'none' && !i.labels.includes(label)) return false;
  return `${i.title} ${i.description} ${i.labels.join(' ')} ${i.assignee} ${memberName(i.assignee)} ${itemProjectIDs(i).map(projectName).join(' ')}`.toLowerCase().includes(query);
 });
}
function cardRenderSignature(item, links) {
 const linkIdentity = links.map(link => ({id:link.id, project:link.project, kind:link.kind, number:link.number, items:link.items}));
 const itemView = {id:item.id, title:item.title, column_id:item.column_id, project_id:item.project_id, project_ids:itemProjectIDs(item), assignee:item.assignee, labels:item.labels, sprint_ids:item.sprint_ids, archived:item.archived, attachments:attachmentsLoaded(item) ? item.attachments : null, attachment_count:attachmentCount(item)};
 return JSON.stringify({item:itemView, links:linkIdentity, projects:itemProjectIDs(item).map(projectName), assignee:memberInfo(item.assignee), sprints:item.sprint_ids.map(id => board.sprints.find(s => s.id === id)?.name || id), labels:item.labels.map(labelInfo), blocked:blocked(item)});
}
function observationOutcomeText(link) {
 const outcomes = {unobserved:'Not observed',ok:'Observed',inaccessible:'Access denied',not_found:'Not found or hidden',unavailable:'Unavailable',invalid_response:'Invalid response',rate_limited:'Rate limited',busy:'Connector busy',disabled:'Disabled',outdated:'Older result ignored',refreshing:'Refresh pending'};
 return outcomes[link.outcome] || 'Observation unavailable';
}
function observationIsStale(link) { if (link.refresh_pending || link.outcome === 'refreshing') return true; if (!link.last_success) return false; const timestamp = Date.parse(link.last_success); return Number.isNaN(timestamp) || Date.now() - timestamp > 5 * 60 * 1000 || link.outcome !== 'ok'; }
function observationTooltip(link) {
 const observation = link.observation; const parts = [];
 if (observation?.title) parts.push(observation.title);
 if (observation?.mr_state) parts.push(`MR: ${observation.mr_state}${observation.draft ? ' · draft' : ''}`);
 if (observation?.pipeline) parts.push(`Pipeline: ${observation.pipeline.state || 'unknown'}`);
 if (!observation || link.outcome !== 'ok') parts.push(observationOutcomeText(link));
 if (observationIsStale(link)) parts.push('Stale');
 parts.push(observationTiming(link)); return `${linkLabel(link)} · ${parts.join(' · ')}`;
}
function observationIconTarget(target) { return target instanceof Element ? target.closest('.card-observation-icon') : undefined; }
function positionObservationTooltip(target) {
 const tooltipStyle = getComputedStyle(target, '::after'); const width = Number.parseFloat(tooltipStyle.width) || 320; const height = Number.parseFloat(tooltipStyle.height) || 0;
 const rootStyle = getComputedStyle(document.documentElement); const gap = Number.parseFloat(rootStyle.getPropertyValue('--s1')) || 4; const edge = Number.parseFloat(rootStyle.getPropertyValue('--s4')) || 16; const targetBox = target.getBoundingClientRect(); const maxLeft = Math.max(edge, innerWidth - width - edge); const left = Math.min(Math.max(edge, targetBox.left), maxLeft); const below = targetBox.bottom + gap; const top = below + height <= innerHeight - edge ? below : Math.max(edge, targetBox.top - gap - height);
 target.style.setProperty('--observation-tooltip-left', `${Math.round(left)}px`); target.style.setProperty('--observation-tooltip-top', `${Math.round(top)}px`);
}
function repositionObservationTooltip() {
 const target = observationTooltipTarget; if (!target?.isConnected || (!target.matches(':hover') && document.activeElement !== target)) { observationTooltipTarget = undefined; return; }
 positionObservationTooltip(target);
}
function observationIconState(link) {
 if (link.refresh_pending || link.outcome === 'refreshing') return {symbol:'↻', status:'pending', stale:true};
 if (!link.observation) return {symbol:link.outcome && link.outcome !== 'unobserved' && link.outcome !== 'ok' ? '!' : '?', status:link.outcome && link.outcome !== 'unobserved' && link.outcome !== 'ok' ? 'warning' : 'unknown', stale:false};
 if (link.outcome && link.outcome !== 'ok') return {symbol:'!', status:'warning', stale:observationIsStale(link)};
 const state = String(link.observation.mr_state || '').toLowerCase();
 if (state === 'merged') return {symbol:'✓', status:'merged', stale:observationIsStale(link)};
 if (state === 'closed') return {symbol:'×', status:'closed', stale:observationIsStale(link)};
 if (link.observation.draft) return {symbol:'◐', status:'draft', stale:observationIsStale(link)};
 if (state === 'opened') return {symbol:'●', status:'open', stale:observationIsStale(link)};
 return {symbol:'?', status:'unknown', stale:observationIsStale(link)};
}
function cardObservationIcon(link, focusKey) {
 const state = observationIconState(link); const icon = el('span', state.symbol, 'card-observation-icon'); const tooltip = observationTooltip(link);
 icon.dataset.linkId = link.id; icon.dataset.observation = 'status-icon'; icon.dataset.status = state.status; icon.dataset.stale = String(state.stale); icon.dataset.focusKey = focusKey || `link:${link.id}:observation`; icon.dataset.tooltip = tooltip; icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', `Card observation: ${tooltip}`); icon.tabIndex = 0; return icon;
}
function card(item, peers) {
 const c = el('article', undefined, 'card'); const top = el('div', undefined, 'card-top'); const title = button(item.title, () => editItem(item), 'card-title'); title.dataset.focusKey = `item:${item.id}:title`; top.append(title);
 c.dataset.item = item.id;
 makeDraggable(c, 'card', item.id, item.title);
 dropZone(c, 'card', (id, after) => { const current = board.items.find(value => value.id === item.id) || item; const currentPeers = filteredItems().filter(value => value.column_id === current.column_id); const index = currentPeers.findIndex(value => value.id === current.id); return {kind: 'item.move', target: id, destination: current.column_id, before: after ? currentPeers[index + 1]?.id || '' : current.id}; });
 const meta = el('div', undefined, 'card-meta'); const projects = el('div', undefined, 'card-projects'); projects.append(...projectBadges(item)); meta.append(projects, assigneeView(item.assignee));
 c.append(top, meta);
 const sprintTags = el('div', undefined, 'tags'); sprintTags.dataset.cardSection = 'sprints'; item.sprint_ids.forEach(id => { const tag = el('span', board.sprints.find(s => s.id === id)?.name || id, 'badge'); tag.dataset.sprintId = id; sprintTags.append(tag); }); c.append(sprintTags);
 const tags = el('div', undefined, 'tags'); tags.dataset.cardSection = 'labels'; item.labels.forEach(l => tags.append(labelBadge(l))); if (blocked(item)) tags.append(el('span', 'Blocked by dependency', 'badge warning')); if (item.archived) tags.append(el('span', 'Archived', 'badge')); c.append(tags);
 if (item.archived) {
  const controls = el('div', undefined, 'card-controls');
  controls.append(writeButton('Restore item', () => quick({ kind: 'item.restore', target: item.id })));
  c.append(controls);
 }
 const links = board.links.filter(l => l.items.includes(item.id));
 if (links.length) {
  const linkSection = el('div', undefined, 'card-links-section'); linkSection.setAttribute('role', 'group'); linkSection.setAttribute('aria-label', 'GitLab links');
  const linkHead = el('div', undefined, 'card-links-head'); const linkLabel = el('span', `GitLab links · ${links.length}`, 'card-links-label'); linkLabel.dataset.renderSignature = `links:${links.length}`; const details = button('View observations', () => showLinks(item), 'card-link-details'); details.dataset.renderSignature = 'observations-action'; details.dataset.focusKey = `item:${item.id}:observations`; details.setAttribute('aria-label', `View GitLab details · ${links.length}`); details.title = 'Show linked GitLab observations'; linkHead.append(linkLabel, details);
  const linkList = el('div', undefined, 'card-links'); linkList.setAttribute('aria-label', 'GitLab links'); links.forEach(link => { if (link.kind === 'mr') linkList.append(cardObservationIcon(link, `item:${item.id}:observation:${link.id}`)); linkList.append(cardLinkView(link, `item:${item.id}:link:${link.id}`)); }); linkSection.append(linkHead, linkList); c.append(linkSection);
 }
 const total = attachmentCount(item);
 if (total) {
  const attachmentList = el('details', undefined, 'card-attachments'); attachmentList.dataset.stateKey = `item:${item.id}:attachments`; const count = `${total} attachment${total === 1 ? '' : 's'}`; attachmentList.setAttribute('aria-label', count);
  const attachmentHead = el('summary', undefined, 'card-attachments-head'); const attachmentToggle = el('span', undefined, 'card-attachments-toggle'); attachmentToggle.setAttribute('aria-hidden', 'true'); attachmentHead.append(attachmentPaperclip(), el('span', 'Attachments', 'card-attachments-label'), el('span', String(total), 'card-attachments-count'), attachmentToggle);
  const attachmentOptions = el('div', undefined, 'card-attachment-list');
  // Expanding the summary is what pays for the metadata read.
  if (attachmentsLoaded(item)) item.attachments.forEach(attachment => { const link = attachmentTileLink(item, attachment); link.classList.add('card-attachment-option'); attachmentOptions.append(link); });
  else attachmentOptions.append(el('p', 'Loading attachments…', 'empty'));
  attachmentList.addEventListener('toggle', () => { if (attachmentList.open) void ensureAttachments(item); });
  attachmentList.append(attachmentHead, attachmentOptions); c.append(attachmentList);
 }
 c.dataset.renderSignature = cardRenderSignature(item, links);
 return c;
}
function linkIdentitySignature(link) { return JSON.stringify({id:link.id, project:link.project, kind:link.kind, number:link.number, items:[...(link.items || [])].sort()}); }
function observationSignature(link) { return JSON.stringify({observation:link.observation || null, last_success:link.last_success || null, last_attempt:link.last_attempt || null, outcome:link.outcome || '', next_refresh:link.next_refresh || null, refresh_pending:!!link.refresh_pending}); }
function patchObservationIcon(node, link) {
 const replacement = cardObservationIcon(link, node.dataset.focusKey); if (node.tagName === replacement.tagName) { syncAttributes(node, replacement); if (node.textContent !== replacement.textContent) node.textContent = replacement.textContent; if (observationTooltipTarget === node) positionObservationTooltip(node); return node; }
 node.replaceWith(replacement); return replacement;
}
function patchObservationLink(node, link) {
 const replacement = cardLinkView(link, node.dataset.focusKey); if (node.tagName === replacement.tagName) { syncAttributes(node, replacement); if (node.textContent !== replacement.textContent) node.textContent = replacement.textContent; return node; }
 node.replaceWith(replacement); return replacement;
}
function refreshLinkDisabled(link) { return !writable() || !link || !board.connector_instance || board.connector_instance !== board.integration.instance || !!link.next_refresh && Date.parse(link.next_refresh) > Date.now(); }
function patchRefreshControl(node, link) { node.disabled = refreshLinkDisabled(link); const row = node.closest('.setup-row'); const next = row?.querySelector('[data-observation="next-refresh"]'); if (next) { next.hidden = !link?.next_refresh || Date.parse(link.next_refresh) <= Date.now(); if (!next.hidden) next.textContent = `Next refresh after ${new Date(link.next_refresh).toLocaleTimeString()}. The refresh control becomes available after that time.`; } }
function patchObservationUI(previousLinks, nextLinks) {
 const previous = new Map(previousLinks.map(link => [link.id, link])); const changed = nextLinks.filter(link => previous.has(link.id) && observationSignature(previous.get(link.id)) !== observationSignature(link));
 if (!changed.length) return false;
 changed.forEach(link => {
  document.querySelectorAll('[data-observation="status-icon"]').forEach(node => { if (node.dataset.linkId === link.id) patchObservationIcon(node, link); });
  document.querySelectorAll('[data-observation="link"]').forEach(node => { if (node.dataset.linkId === link.id) patchObservationLink(node, link); });
  document.querySelectorAll('[data-refresh-link]').forEach(node => { if (node.dataset.refreshLink === link.id) patchRefreshControl(node, link); });
 });
 return true;
}
function currentBurndownKey(sprintID) { return [board?.workspace.revision || 0, sprintID, $('project').value, $('assignee').value].join('|'); }
function selectedFilterText(id) { return $(id).selectedOptions[0]?.textContent || 'All'; }
function burndownSegments(points, key, x, y) {
 const segments = []; let segment = [];
 const flush = () => { if (segment.length > 1) segments.push(segment.join(' ')); segment = []; };
 points.forEach((point, index) => { if (!Number.isFinite(point[key])) { flush(); return; } segment.push(`${x(index)},${y(point[key])}`); }); flush(); return segments;
}
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
 const details = el('details', undefined, 'burndown-data'); details.dataset.stateKey = `burndown-data:${data.sprint.id}`; details.append(el('summary', 'View daily values')); const scroll = el('div', undefined, 'burndown-table-scroll'); const table = el('table'); table.append(el('caption', 'Daily native work-item counts')); const head = el('thead'); const heading = el('tr'); const metric = el('th', 'Metric'); metric.scope = 'col'; heading.append(metric); data.points.forEach(point => { const date = el('th', burndownDateLabel(point.date)); date.scope = 'col'; heading.append(date); }); head.append(heading); table.append(head); const body = el('tbody'); [['In scope', 'scope'], ['Remaining', 'remaining']].forEach(([label, key]) => { const row = el('tr'); const metric = el('th', label); metric.scope = 'row'; row.append(metric); data.points.forEach(point => row.append(el('td', point[key] == null ? '—' : String(point[key])))); body.append(row); }); table.append(body); scroll.append(table); details.append(scroll); return details;
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
function patchNode(target, next) {
 if (target === next) return target;
 if (target.tagName !== next.tagName) { target.replaceWith(next); return next; }
 if (next.dataset.renderSignature && target.dataset.renderSignature === next.dataset.renderSignature) return target;
 const details = [...target.querySelectorAll('details')].map((node, index) => ({key:node.dataset.stateKey || `details:${index}`, open:node.open}));
 syncAttributes(target, next); target.replaceChildren(...next.childNodes);
 details.forEach(state => { const node = [...target.querySelectorAll('details')].find(candidate => (candidate.dataset.stateKey || '') === state.key); if (node) node.open = state.open; });
 return target;
}
function keyedNodeKey(node) { if (node.dataset.item) return `item:${node.dataset.item}`; if (node.dataset.sprintId) return `sprint:${node.dataset.sprintId}`; if (node.dataset.column) return `column:${node.dataset.column}`; if (node.classList.contains('column-head')) return 'head'; return node.dataset.empty ? 'empty' : node.className || node.tagName; }
function reconcileKeyedChildren(parent, nextNodes, keyOf, patch = patchNode, resolve) {
 const existing = new Map([...parent.children].map(node => [keyOf(node), node])); const used = new Set(); let cursor = parent.firstElementChild;
 nextNodes.forEach(next => {
  const key = keyOf(next); let target = existing.get(key); if (!target && resolve) target = resolve(key, next);
  if (!target || used.has(target)) target = next; used.add(target);
  if (target !== cursor) parent.insertBefore(target, cursor);
  if (target !== next) { const patched = patch(target, next); if (patched && patched !== target) { used.delete(target); used.add(patched); target = patched; } }
  cursor = target.nextElementSibling;
 });
 while (cursor) { const next = cursor.nextElementSibling; if (!used.has(cursor)) cursor.remove(); cursor = next; }
}
function renderColumn(col, items) {
 const section = el('section', undefined, 'column'); section.dataset.column = col.id; section.setAttribute('aria-label', col.name);
 const peers = items.filter(item => item.column_id === col.id); const total = board.items.filter(item => !item.archived && item.column_id === col.id).length;
 const head = el('div', undefined, 'column-head'); head.dataset.renderSignature = JSON.stringify({id:col.id, name:col.name, category:col.category, wip:col.wip, shown:peers.length, total}); head.append(el('h3', col.name), el('small', `${peers.length} shown · ${columnWIPLabel(col, total)}`)); makeDraggable(head, 'list', col.id, col.name);
 dropZone(section, 'card', id => ({kind: 'item.move', target: id, destination: col.id}), 'end'); dropZone(section, 'list', (id, after) => ({kind: 'column.rank', target: id, before: after ? board.columns[board.columns.findIndex(value => value.id === col.id) + 1]?.id || '' : col.id}), 'x'); section.append(head); appendCards(section, peers); if (!peers.length) { const empty = el('p', 'No work here', 'empty'); empty.dataset.empty = 'true'; section.append(empty); }
 section.dataset.renderSignature = JSON.stringify({id:col.id, name:col.name, category:col.category, wip:col.wip}); return section;
}
function cardChildKey(node) {
 if (node.classList.contains('card-top')) return 'top';
 if (node.classList.contains('card-meta')) return 'meta';
 if (node.classList.contains('tags')) return `tags:${node.dataset.cardSection || ''}`;
 if (node.classList.contains('card-links-section') || node.classList.contains('card-links')) return 'links';
 if (node.classList.contains('card-attachments')) return 'attachments';
 if (node.classList.contains('card-controls')) return 'controls';
 return node.className || node.tagName;
}
function cardLinkChildKey(node) { if (node.dataset.observation === 'status-icon') return `status:${node.dataset.linkId}`; if (node.dataset.observation === 'link') return `link:${node.dataset.linkId}`; return 'details'; }
function patchCardLinksHead(target, next) {
 syncAttributes(target, next); reconcileKeyedChildren(target, [...next.children], node => node.classList.contains('card-links-label') ? 'label' : 'details', patchNode); return target;
}
function patchCardLinksSection(target, next) {
 syncAttributes(target, next); const currentHead = target.querySelector('.card-links-head'); const nextHead = next.querySelector('.card-links-head'); if (currentHead && nextHead) patchCardLinksHead(currentHead, nextHead);
 const currentLinks = target.querySelector('.card-links'); const nextLinks = next.querySelector('.card-links'); if (currentLinks && nextLinks) patchCardLinks(currentLinks, nextLinks); return target;
}
function patchCardLinks(target, next) {
 syncAttributes(target, next);
 reconcileKeyedChildren(target, [...next.children], cardLinkChildKey, (current, fresh) => {
  const link = board.links.find(value => value.id === fresh.dataset.linkId);
  if (link && fresh.dataset.observation === 'status-icon') return patchObservationIcon(current, link);
  if (link && fresh.dataset.observation === 'link') return patchObservationLink(current, link);
  return patchNode(current, fresh);
 });
 return target;
}
function patchCardAttachments(target, next) {
 syncAttributes(target, next);
 const currentHead = target.firstElementChild; const nextHead = next.firstElementChild; if (currentHead && nextHead) patchNode(currentHead, nextHead);
 const currentList = target.querySelector('.card-attachment-list'); const nextList = next.querySelector('.card-attachment-list');
 if (currentList && nextList) { syncAttributes(currentList, nextList); reconcileKeyedChildren(currentList, [...nextList.children], node => `attachment:${node.dataset.attachmentId || node.textContent}`, patchNode); }
 return target;
}
function patchCardTags(target, next) {
 syncAttributes(target, next);
 reconcileKeyedChildren(target, [...next.children], node => node.dataset.sprintId ? `sprint:${node.dataset.sprintId}` : node.dataset.label ? `label:${node.dataset.label}` : `state:${node.textContent}`, patchNode);
 return target;
}
function patchCard(target, next) {
 if (target === next) return target;
 if (target.dataset.renderSignature === next.dataset.renderSignature) { const currentLinks = target.querySelector('.card-links-section'); const nextLinks = next.querySelector('.card-links-section'); if (currentLinks && nextLinks) patchCardLinksSection(currentLinks, nextLinks); return target; }
 syncAttributes(target, next);
 reconcileKeyedChildren(target, [...next.children], cardChildKey, (current, fresh) => {
  if (fresh.classList.contains('card-links-section')) return patchCardLinksSection(current, fresh);
  if (fresh.classList.contains('card-links')) return patchCardLinks(current, fresh);
  if (fresh.classList.contains('card-attachments')) return patchCardAttachments(current, fresh);
  if (fresh.classList.contains('tags')) return patchCardTags(current, fresh);
  return patchNode(current, fresh);
 });
 return target;
}
function patchColumn(target, next, cardPool) {
 syncAttributes(target, next);
 reconcileKeyedChildren(target, [...next.children], keyedNodeKey, (current, fresh) => fresh.dataset.item ? patchCard(current, fresh) : patchNode(current, fresh), (key) => key.startsWith('item:') ? cardPool.get(key.slice('item:'.length)) : undefined);
}
function renderBoardContent(content, items) {
 const next = el('div', undefined, 'board'); next.dataset.contentView = 'board'; board.columns.forEach(column => next.append(renderColumn(column, items)));
 const current = content.firstElementChild;
 if (!current || current.dataset.contentView !== 'board') { content.replaceChildren(next); return; }
 const cardPool = new Map([...current.querySelectorAll('.card')].map(node => [node.dataset.item, node]));
 reconcileKeyedChildren(current, [...next.children], node => `column:${node.dataset.column}`, (target, fresh) => patchColumn(target, fresh, cardPool));
}
function renderCardListContent(content, items) {
 const next = el('div', undefined, 'list'); next.dataset.contentView = `list:${view}`; appendCards(next, items); if (!items.length) { const empty = el('p', view === 'board' && $('scope').value === 'backlog' ? 'Backlog is clear. Create work without a sprint to plan what comes next.' : 'No matching work.', 'empty'); empty.dataset.empty = 'true'; next.append(empty); }
 const current = content.firstElementChild;
 if (!current || current.dataset.contentView !== next.dataset.contentView) { content.replaceChildren(next); return; }
 reconcileKeyedChildren(current, [...next.children], keyedNodeKey, (target, fresh) => fresh.dataset.item ? patchCard(target, fresh) : patchNode(target, fresh));
}
function listCell(label, className) { const cell = el('div', undefined, `list-cell ${className || ''}`.trim()); cell.dataset.label = label; cell.append(el('span', label, 'list-cell-label')); return cell; }
function listTableHeader() { const header = el('div', undefined, 'list-table-head'); ['Title', 'Project', 'Assignee', 'Labels', 'Sprints', 'Links / Status'].forEach(label => header.append(el('span', label, 'list-table-heading'))); return header; }
function listRow(item) {
 const row = el('article', undefined, 'list-row'); row.dataset.item = item.id; row.dataset.focusKey = `item:${item.id}:list-row`; row.tabIndex = 0; row.setAttribute('aria-label', `Open work item ${item.title}`);
 row.addEventListener('click', event => { if (event.defaultPrevented || event.target.closest?.('a,button,input,select,textarea,summary')) return; selectItem(item.id, row); });
 row.addEventListener('keydown', event => { if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return; event.preventDefault(); selectItem(item.id, row); });
 makeDraggable(row, 'card', item.id, item.title); row.setAttribute('aria-label', `Open work item ${item.title}; draggable`);
 dropZone(row, 'card', (id, after) => { const current = board.items.find(value => value.id === item.id) || item; const currentPeers = filteredItems().filter(value => value.column_id === current.column_id); const index = currentPeers.findIndex(value => value.id === current.id); return {kind: 'item.move', target: id, destination: current.column_id, before: after ? currentPeers[index + 1]?.id || '' : current.id}; });
 const title = listCell('Title', 'list-cell-title'); const titleButton = button(item.title, () => selectItem(item.id, row), 'list-row-title'); titleButton.dataset.focusKey = `item:${item.id}:list-title`; title.append(titleButton);
 const project = listCell('Project', 'list-cell-project'); const projectValue = el('span', undefined, 'list-row-project'); projectValue.append(...projectBadges(item)); project.append(projectValue);
 const status = listCell('Links / Status', 'list-cell-status'); const statusContent = el('div', undefined, 'list-row-status-content'); const state = el('div', undefined, 'list-row-status-badges'); if (blocked(item)) state.append(el('span', 'Blocked', 'badge warning')); if (item.archived) state.append(el('span', 'Archived', 'badge')); if (state.childElementCount) statusContent.append(state);
 const links = board.links.filter(link => link.items.includes(item.id)); if (links.length) { const linkIndicator = el('div', undefined, 'list-row-indicator list-row-links'); linkIndicator.setAttribute('aria-label', `${links.length} GitLab link${links.length === 1 ? '' : 's'}`); const linkHead = el('div', undefined, 'card-links-head'); const linkLabel = el('span', `GitLab links · ${links.length}`, 'card-links-label'); const observationLink = button('View observations', () => showLinks(item), 'card-link-details list-row-observation-link'); observationLink.dataset.focusKey = `item:${item.id}:list-observations`; observationLink.setAttribute('aria-label', `View observations · ${links.length} GitLab link${links.length === 1 ? '' : 's'}`); observationLink.title = 'Show linked GitLab observations'; linkHead.append(linkLabel, observationLink); linkIndicator.append(linkHead); links.forEach(link => { const line = el('span', undefined, 'list-row-link-line'); if (link.kind === 'mr') line.append(cardObservationIcon(link, `item:${item.id}:list-observation:${link.id}`)); line.append(cardLinkView(link, `item:${item.id}:list-link:${link.id}`)); linkIndicator.append(line); }); statusContent.append(linkIndicator); }
 const attachmentTotal = attachmentCount(item); if (attachmentTotal) { const attachmentIndicator = el('span', undefined, 'list-row-indicator list-row-attachments'); attachmentIndicator.setAttribute('aria-label', `${attachmentTotal} attachment${attachmentTotal === 1 ? '' : 's'}`); attachmentIndicator.append(attachmentPaperclip(), el('span', String(attachmentTotal))); statusContent.append(attachmentIndicator); }
 if (statusContent.childElementCount) status.append(statusContent); else status.append(el('span', '—', 'list-cell-empty'));
 const assignee = listCell('Assignee', 'list-cell-assignee'); assignee.append(assigneeView(item.assignee));
 const labels = listCell('Labels', 'list-cell-labels'); item.labels.forEach(label => labels.append(labelBadge(label))); if (labels.childElementCount === 1) labels.append(el('span', '—', 'list-cell-empty'));
 const sprints = listCell('Sprints', 'list-cell-sprints'); item.sprint_ids.forEach(id => sprints.append(el('span', board.sprints.find(s => s.id === id)?.name || id, 'badge'))); if (sprints.childElementCount === 1) sprints.append(el('span', '—', 'list-cell-empty'));
 row.append(title, project, assignee, labels, sprints, status);
 row.classList.toggle('is-selected', selectedItemID === item.id); row.dataset.renderSignature = `${cardRenderSignature(item, links)}|selected:${selectedItemID === item.id}`; return row;
}
function listSection(column, items) {
 const section = el('details', undefined, 'list-section'); section.dataset.column = column.id; section.open = true; section.setAttribute('aria-label', column.name);
 const peers = items.filter(item => item.column_id === column.id); const total = board.items.filter(item => !item.archived && item.column_id === column.id).length;
 const head = el('summary', undefined, 'list-section-head'); head.dataset.renderSignature = JSON.stringify({id:column.id, name:column.name, category:column.category, wip:column.wip, shown:peers.length, total}); const title = el('span', undefined, 'list-section-title'); title.append(el('h3', column.name)); const summary = el('span', `${peers.length} shown · ${columnWIPLabel(column, total)}`, 'list-section-summary'); head.append(title, summary); makeDraggable(head, 'list', column.id, column.name);
 dropZone(section, 'card', id => ({kind: 'item.move', target: id, destination: column.id}), 'end'); dropZone(section, 'list', (id, after) => ({kind: 'column.rank', target: id, before: after ? board.columns[board.columns.findIndex(value => value.id === column.id) + 1]?.id || '' : column.id}), 'x');
 const body = el('div', undefined, 'list-section-body'); body.append(...peers.map(item => listRow(item))); if (!peers.length) { const empty = el('p', 'No work here', 'empty'); empty.dataset.empty = 'true'; body.append(empty); } section.append(head, body); section.dataset.renderSignature = JSON.stringify({id:column.id, name:column.name, category:column.category, wip:column.wip}); return section;
}
function patchListSection(target, next) {
 const expanded = target.open; syncAttributes(target, next); const currentHead = target.querySelector(':scope > .list-section-head'); const nextHead = next.querySelector(':scope > .list-section-head'); if (currentHead && nextHead) patchNode(currentHead, nextHead);
 const currentBody = target.querySelector(':scope > .list-section-body'); const nextBody = next.querySelector(':scope > .list-section-body'); if (currentBody && nextBody) { syncAttributes(currentBody, nextBody); reconcileKeyedChildren(currentBody, [...nextBody.children], keyedNodeKey, (current, fresh) => fresh.dataset.item ? patchNode(current, fresh) : patchNode(current, fresh)); }
 target.open = expanded; return target;
}
function renderListPresentationContent(content, items) {
 const current = content.firstElementChild; let layout, sections;
 if (!current || current.dataset.contentView !== 'list:board') {
  layout = el('div', undefined, 'list-detail-layout'); layout.dataset.contentView = 'list:board'; const list = el('div', undefined, 'planning-list'); list.dataset.contentView = 'planning-list'; sections = el('div', undefined, 'list-sections'); list.append(listTableHeader(), sections); const pane = createDetailPane(); layout.append(list, pane); content.replaceChildren(layout);
 } else { layout = current; sections = layout.querySelector(':scope > .planning-list > .list-sections'); }
 const nextSections = board.columns.map(column => listSection(column, items)); reconcileKeyedChildren(sections, nextSections, node => `column:${node.dataset.column}`, patchListSection); syncListSelection(); updateDetailPaneVisibility();
}
function sprintFilterItems(sprint) {
 const project = $('project').value; const assignee = $('assignee').value;
 return scopeItems(sprint).filter(item => { const projectIDs = itemProjectIDs(item); if (project === 'none' && projectIDs.length) return false; if (project !== 'all' && project !== 'none' && !projectIDs.includes(project)) return false; if (assignee === 'none' && item.assignee) return false; if (assignee !== 'all' && assignee !== 'none' && item.assignee !== assignee) return false; return true; });
}
function renderSprintRows(list) {
 const search = $('search').value.trim(); const query = search.toLowerCase(); const matches = board.sprints.filter(sprint => !query || `${sprint.name || ''} ${sprint.goal || ''}`.toLowerCase().includes(query)); $('count').textContent = `${matches.length} ${matches.length === 1 ? 'sprint' : 'sprints'}`; list.replaceChildren();
 if (!matches.length) { const empty = el('p', board.sprints.length && query ? `No sprints match “${search}”.` : 'No sprints yet. Create a goal and time box, then add work from the backlog.', 'empty'); empty.dataset.empty = 'true'; list.append(empty); return; }
 matches.forEach(sprint => list.append(sprintPanel(sprint, sprintFilterItems(sprint))));
}
function renderSprintPage(content) {
 const head = el('div', undefined, 'section-head'); head.dataset.renderSignature = 'sprint-page-head'; head.append(el('h2', 'Goals, scope, and deliberate carry-over'), writeButton('＋ New sprint', () => editSprint(), 'primary'));
 const list = el('div', undefined, 'sprints'); list.dataset.contentView = 'sprint-page-list'; renderSprintRows(list);
 const currentHead = content.firstElementChild; const currentList = content.children[1];
 if (!currentHead || !currentList || currentList.dataset.contentView !== list.dataset.contentView) { content.replaceChildren(head, list); return; }
 patchNode(currentHead, head); reconcileKeyedChildren(currentList, [...list.children], keyedNodeKey);
}
function renderSprintSummary(sprints) {
 const summary = $('sprint-summary'); if (view !== 'board') { summary.replaceChildren(); return; }
 const next = sprints.map(sprint => sprintPanel(sprint)); if (!next.length) { const empty = el('p', 'No active sprint. Use Sprint planning to create and start one, or keep a continuous Kanban flow.', 'empty'); empty.dataset.empty = 'true'; next.push(empty); }
 reconcileKeyedChildren(summary, next, keyedNodeKey);
}
function renderContent() {
 if (!board) return; const content = $('content');
 if (view === 'projects') { content.replaceChildren(); renderProjects(content); return; }
 if (view === 'labels') { content.replaceChildren(); renderLabels(content); return; }
 if (view === 'members') { content.replaceChildren(); renderMembers(content); return; }
 if (view === 'sprints') { renderSprintPage(content); return; }
 if (view === 'history') { content.replaceChildren(); renderHistory(content); return; }
 const items = filteredItems(); $('count').textContent = view === 'archive' ? `${items.length} archived${archiveMore ? '+' : ''} · workspace revision ${board.workspace.revision}` : `${items.length} items · workspace revision ${board.workspace.revision}`;
 if (view === 'board' && presentation === 'list') renderListPresentationContent(content, items); else if (view === 'board') renderBoardContent(content, items); else renderCardListContent(content, items);
 content.querySelector(':scope > .archive-more')?.remove();
 if (view === 'archive' && archiveMore) { const more = button('Load older archived work', async () => { try { await loadArchive(); renderContent(); } catch (e) { notice(e.message, true); } }, 'archive-more'); more.disabled = busy || loading; content.append(more); }
}
function appendCards(parent, items) { items.forEach(i => parent.append(card(i, items))); }
async function loadHistory(reset = false) { const events = await api(root + '/history' + (!reset && historyBefore ? `?before=${historyBefore}` : '')); history = reset ? events : [...history, ...events]; historyBefore = events.at(-1)?.id || 0; historyMore = events.length === 50; }
const ARCHIVE_PAGE = 50;
function resetArchive() { archiveItems = []; archiveOffset = 0; archiveMore = false; }
async function loadArchive(reset = false) {
 const offset = reset ? 0 : archiveOffset;
 const page = await api(`${root}/archive?offset=${offset}&limit=${ARCHIVE_PAGE}`);
 if (!Array.isArray(page)) throw new Error('Archive response is invalid. Refresh to retry.');
 archiveItems = reset ? page : [...archiveItems, ...page]; archiveOffset = offset + page.length; archiveMore = page.length === ARCHIVE_PAGE;
}
function showWorkspaceSelection() { if (busy || loading) return; workspaceGate = 'select'; render(); document.querySelector('[data-workspace-choice]')?.focus(); }
function showWorkspaceCreate() { if (busy || loading || integrationFormOpen) return; workspaceCreateKey = ''; workspaceCreateName = ''; if (board) { enterWorkspaceGate('create', 'Create a workspace to add another planning space.'); return; } workspaceGate = 'create'; render(); }
async function createWorkspace(event) {
 event.preventDefault(); if (workspaceCreating || busy || loading) return;
 const form = event.currentTarget; const input = form.elements.name; const status = form.querySelector('[data-workspace-create-status]'); const submit = form.querySelector('button[type="submit"]'); const name = String(input.value || '').trim();
 const setStatus = (text, error = false) => { status.textContent = text || ''; status.hidden = !text; status.className = error ? 'workspace-create-status error' : 'workspace-create-status'; status.setAttribute('role', error ? 'alert' : 'status'); };
 if (!name || name.length > 120 || /[\u0000\r\n]/.test(name)) { setStatus('Workspace name must be between 1 and 120 characters.', true); input.focus(); return; }
 if (workspaceCreateName !== name || !workspaceCreateKey) { workspaceCreateName = name; workspaceCreateKey = requestKey(); }
 workspaceCreating = true; submit.disabled = true; input.disabled = true; setStatus('Creating workspace…');
 try {
  const created = await api('/api/v2/workspaces', {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf,'Idempotency-Key':workspaceCreateKey}, body:JSON.stringify({name})});
  if (!validWorkspaceList([created])) throw new Error('Workspace response is invalid. Refresh to retry.');
  const next = await loadWorkspaces(created.id); if (!next.some(workspace => workspace.id === created.id)) throw new Error('The new workspace is not available yet. Refresh to retry.');
  pendingPlanningURLState = undefined; if (!await chooseWorkspace(created.id)) throw new Error('Workspace created, but its board could not be opened. Refresh to retry.'); workspaceCreateKey = ''; workspaceCreateName = '';
 } catch (error) {
  if (!document.querySelector('[data-workspace-create-status]')) { workspaceGate = 'create'; root = undefined; render(); }
  const currentForm = document.querySelector('.workspace-create-form'); const currentStatus = currentForm?.querySelector('[data-workspace-create-status]'); const currentInput = currentForm?.elements.name; if (currentInput && !currentInput.value) currentInput.value = workspaceCreateName || name; if (currentStatus) { currentStatus.textContent = error.message; currentStatus.hidden = false; currentStatus.className = 'workspace-create-status error'; currentStatus.setAttribute('role', 'alert'); } if (currentInput) currentInput.focus();
 } finally { workspaceCreating = false; const currentForm = document.querySelector('.workspace-create-form'); if (currentForm) { currentForm.elements.name.disabled = false; currentForm.querySelector('button[type="submit"]').disabled = false; } renderControls(); }
}
function historyActorLabel(subject) {
 const member = board.members.find(candidate => candidate.subject === subject);
 const name = member ? memberListingInfo(member).name : subject === session?.subject ? String(session.name || '').trim() : '';
 return name ? `${name} (${subject})` : subject;
}
function renderHistory(content) {
 const label = workspaceHistoryLabel(board.workspace); content.append(el('p', label, 'muted'));
 if (!history.length) content.append(el('p', 'No planning changes yet.', 'empty'));
 history.forEach(e => { const row = el('article', undefined, 'history-row'); row.append(el('strong', e.action.replaceAll('.', ' · ')), el('p', `${historyActorLabel(e.actor)} · ${new Date(e.at).toLocaleString()} · ${label} · ${e.legacy_project_id ? 'legacy project' : 'workspace'} revision ${e.revision}`, 'muted')); if (e.target) row.append(el('small', `Target ${e.target}`, 'card-id')); if (e.reason) row.append(el('p', e.reason)); content.append(row); });
 if (historyMore) content.append(button('Load older changes', async () => { try { await loadHistory(); renderContent(); } catch (e) { notice(e.message, true); } }));
}
function helpPopover(text, name = 'Help') {
 const wrapper = el('span', undefined, 'help-popover'); const trigger = button('?', () => toggle(), 'help-trigger'); const content = el('span', text, 'help-popover-content');
 content.id = `help-${requestKey()}`; content.hidden = true; content.setAttribute('role', 'tooltip'); trigger.setAttribute('aria-label', `Help: ${name}`); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', content.id); trigger.setAttribute('aria-describedby', content.id);
 let outside;
 function close(focus = false) { if (content.hidden) return; content.hidden = true; trigger.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outside); if (focus) trigger.focus(); }
 function open() { content.hidden = false; trigger.setAttribute('aria-expanded', 'true'); outside = e => { if (!wrapper.contains(e.target)) close(); }; document.addEventListener('click', outside); }
 function toggle() { if (content.hidden) open(); else close(true); }
 trigger.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } }); wrapper.append(trigger, content); return wrapper;
}
function multiSelect(parent, name, title, entries, selected = [], decorate, helpText, settings = {}) {
 const single = settings.single === true; const emptyValue = settings.emptyValue; const onChange = settings.onChange; const onFilter = settings.onFilter; const onOpen = settings.onOpen;
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
   input.addEventListener('change', () => { if (single && input.checked) choices.forEach(other => { if (other.input !== input) other.input.checked = false; }); if (emptyValue !== undefined && input.checked) choices.forEach(other => { if (other.input !== input && (input.value === String(emptyValue) || other.value === String(emptyValue))) other.input.checked = false; }); render(); if (onChange) onChange(currentValues()); });
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
  chosen.forEach(choice => { const chip = el('span', undefined, 'multi-select-chip'); chip.append(el('span', choice.text)); if (decorate) decorate(chip, choice.value, choice.text); const remove = button('×', () => { choice.input.checked = false; render(); if (onChange) onChange(currentValues()); root.dispatchEvent(new Event('change', {bubbles:true})); }, 'multi-select-remove'); remove.dataset.multiRemove = 'true'; remove.hidden = !editing; remove.setAttribute('aria-label', `Remove ${choice.text}`); chip.append(remove); values.append(chip); });
  const query = filter.value.trim().toLowerCase(); let visible = 0;
  choices.forEach(choice => { const match = !query || choice.text.toLowerCase().includes(query); choice.option.hidden = !match; if (match) visible++; }); empty.hidden = visible > 0 || !status.hidden;
 }
 controls = {root, group, header, edit, filter, close, isOpen: () => !menu.hidden, setEntries, setStatus, select: selectValue, selected: currentValues};
 filter.addEventListener('input', () => { render(); invoke(onFilter, filter.value.trim()); }); menu.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } });
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
 const returnTo = editorReturn; editorReturn = undefined; hideAttachmentTooltip(); $('editor').close(); if (returnTo) returnTo();
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
function itemEditorDraft(form = $('editor-form')) {
 const data = new FormData(form);
 return {title:String(data.get('title') || ''), description:String(data.get('description') || ''), column_id:String(data.get('column_id') || ''), project_ids:data.getAll('project_id').filter(Boolean), assignee:String(data.get('assignee') || ''), sprint_ids:data.getAll('sprint_ids'), labels:data.getAll('labels'), dependencies:data.getAll('dependencies'), link_ids:data.getAll('link_ids')};
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
async function attachItemGitLabLink(item, link, context) {
 const currentBoard = board, currentRoot = root; const form = context?.form || ($('editor').open ? $('editor-form') : undefined); const draft = form ? itemEditorDraft(form) : undefined; const mode = context?.mode || ($('editor').open ? 'modal' : view === 'board' && presentation === 'list' ? 'detail' : 'modal'); const origin = context?.origin; const previous = new Set(currentBoard.links.filter(value => value.items.includes(item.id)).map(value => value.id)); if (mode === 'modal') closeEditor();
 try { await change({revision:currentBoard.workspace.revision, kind:'link.attach', target:item.id, link}); }
 catch (error) { if (root === currentRoot && board) { const latest = board.items.find(value => value.id === item.id); if (latest && draft) reopenItemEditor(latest, draft, mode, origin); notice(error.message, true); } return; }
 if (root !== currentRoot || !board) return; const latest = board.items.find(value => value.id === item.id); if (!latest) return;
 const added = board.links.filter(value => value.items.includes(item.id) && !previous.has(value.id)).map(value => value.id); reopenItemEditor(latest, draft ? {...draft, link_ids:[...new Set([...draft.link_ids, ...added])]} : undefined, mode, origin);
}
function inlineGitLabPaste(parent, item, readOnly, context) {
 const currentBoard = board, currentRoot = root; const row = el('div', undefined, 'gitlab-paste-row'); const input = el('input'); input.type = 'text'; input.inputMode = 'url'; input.placeholder = 'Paste GitLab MR URL, then press Enter or click Get'; input.maxLength = 2048; input.setAttribute('aria-label', 'GitLab MR URL'); const get = button('Get', resolve, 'primary'); get.dataset.gitlabWrite = 'true'; get.disabled = readOnly || !gitLabWritable(); row.append(input, get);
 const status = el('p', '', 'help'); status.hidden = true; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); const setStatus = (text, error = false) => { status.textContent = text || ''; status.className = error ? 'error' : 'help'; status.hidden = !text; };
 let pending = false;
 async function resolve() {
  if (pending || get.disabled) return; const raw = input.value.trim(); if (!raw) { setStatus('Paste a GitLab merge-request URL first.', true); input.focus(); return; }
  pending = true; get.disabled = true; setStatus('Resolving GitLab merge request…');
  try { const projects = await loadGitLabProjects(currentRoot); if (!row.isConnected || board !== currentBoard || root !== currentRoot) return; const link = resolveGitLabMRURL(raw, currentBoard, projects); await attachItemGitLabLink(item, link, context); }
  catch (error) { if (row.isConnected) { setStatus(error.message, true); input.focus(); } }
  finally { pending = false; if (row.isConnected) get.disabled = !gitLabWritable(); }
 }
 input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); resolve(); } }); parent.append(row, status);
}
async function addGitLabLink(item, context) {
 const currentBoard = board, currentRoot = root; const form = context?.form || ($('editor').open ? $('editor-form') : undefined); const draft = form ? itemEditorDraft(form) : undefined; const mode = context?.mode || ($('editor').open ? 'modal' : view === 'board' && presentation === 'list' ? 'detail' : 'modal'); const origin = context?.origin;
 if (mode === 'modal') closeEditor(); let projects = [], catalogError = '';
 const returnToCard = () => { if (root !== currentRoot || !board) return; const latest = board.items.find(value => value.id === item.id); if (!latest) return; const previous = new Set(currentBoard.links.filter(value => value.items.includes(item.id)).map(value => value.id)); const added = board.links.filter(value => value.items.includes(item.id) && !previous.has(value.id)).map(value => value.id); const returnDraft = draft ? {...draft, link_ids:[...new Set([...draft.link_ids, ...added])]} : undefined; reopenItemEditor(latest, returnDraft, mode, origin); };
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
function commentNode(comment) {
 const row = el('article', undefined, 'comment'); row.dataset.commentId = String(comment.id); row.dataset.renderSignature = JSON.stringify({comment, member:memberInfo(comment.author)});
 const info = memberInfo(comment.author); const avatar = el('span', undefined, 'avatar comment-avatar'); avatar.setAttribute('aria-hidden', 'true'); avatar.append(el('span', initials(info.name), 'avatar-fallback'));
 if (info.avatarURL) { const image = el('img'); image.src = info.avatarURL; image.alt = ''; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.onerror = () => image.remove(); avatar.append(image); }
 const content = el('div', undefined, 'comment-content'); const header = el('div', undefined, 'comment-head'); const author = el('strong', info.name); author.title = comment.author; const time = commentTime(comment.created_at); const created = el('time', time.label, 'muted'); if (time.dateTime) created.dateTime = time.dateTime; header.append(author, created); const body = el('div', undefined, 'comment-body'); renderMarkdown(body, comment.body); content.append(header, body); row.append(avatar, content); return row;
}
function renderCommentList(list, comments) {
 const next = comments.map(commentNode); if (!next.length) { list.replaceChildren(); return; }
 reconcileKeyedChildren(list, next, node => `comment:${node.dataset.commentId}`);
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
   if (board !== currentBoard || root !== currentRoot || !section.isConnected) return; textarea.value = ''; refreshCommentPreview(); textarea.dispatchEvent(new Event('input', {bubbles:true})); await loadComments();
  } catch (error) { if (board === currentBoard && root === currentRoot && section.isConnected) setStatus(error.message, true); }
  finally { commentBusy = false; if (addButton && section.isConnected) { addButton.disabled = !canComment(); renderControls(); } }
 }
 loadComments();
}
function renderItemAttachments(fields, item, readOnly) {
 const currentBoard = board, currentRoot = root;
 const section = el('section', undefined, 'item-attachments'); section.setAttribute('aria-label', 'Attachments');
 const heading = el('div', undefined, 'section-head');
 const headingTitle = el('div', undefined, 'attachment-heading');
 const count = el('span', '0', 'attachment-count'); count.setAttribute('aria-hidden', 'true');
 headingTitle.append(attachmentPaperclip(), el('h3', 'Attachments'), count);
 const status = el('p', '', 'help'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
 const list = el('div', undefined, 'attachment-grid'); let attachmentBusy = false;
 const setStatus = (text, error = false) => { status.textContent = text || ''; status.className = error ? 'error' : 'help'; status.hidden = !text; status.setAttribute('role', error ? 'alert' : 'status'); };
 const onAttachmentsLoaded = id => { if (id !== item.id) return; if (!section.isConnected) { attachmentListeners.delete(onAttachmentsLoaded); return; } renderList(); };
 attachmentListeners.add(onAttachmentsLoaded);
 function renderList() {
  count.textContent = String(attachmentCount(item));
  if (!attachmentsLoaded(item)) { list.replaceChildren(el('p', 'Loading attachments…', 'empty')); void ensureAttachments(item); return; }
  const attachments = item.attachments;
  if (!attachments.length) { list.replaceChildren(el('p', 'No attachments yet.', 'empty')); return; }
  const next = attachments.map(attachment => attachmentTile(item, attachment, currentRoot, `${attachmentSize(attachment.size)} · ${memberName(attachment.uploader)}`, readOnly ? undefined : () => removeAttachment(attachment)));
  reconcileKeyedChildren(list, next, node => `attachment:${node.dataset.attachmentId}`);
 }
 async function removeAttachment(attachment) {
  if (attachmentBusy || !writable()) return; attachmentBusy = true; setStatus(`Removing ${attachment.name}…`);
  try {
   await api(attachmentHref(item, attachment, currentRoot), {method:'DELETE', headers:{'X-CSRF-Token':session.csrf}});
   if (board !== currentBoard || root !== currentRoot || !section.isConnected) return;
   setItemAttachments(item, (item.attachments || []).filter(value => value.id !== attachment.id)); renderList(); renderContent(); setStatus(item.attachments.length ? 'Attachment removed.' : 'No attachments yet.');
  } catch (error) { if (section.isConnected) setStatus(error.message, true); }
  finally { attachmentBusy = false; if (section.isConnected) renderControls(); }
 }
 if (!readOnly) {
  const upload = el('div', undefined, 'attachment-upload'); const hint = el('span', 'Drop files here', 'attachment-drop-hint'); hint.hidden = true;
  const input = el('input'); input.type = 'file'; input.className = 'attachment-file-input'; input.id = `attachment-file-${requestKey()}`; input.tabIndex = -1; input.setAttribute('aria-label', 'Attachment file');
  const add = button('Add attachment', () => input.click(), 'attachment-add'); add.dataset.write = 'true'; add.setAttribute('aria-controls', input.id); add.title = 'Choose a file to attach'; upload.append(add, hint, input); heading.append(headingTitle, upload);
  async function uploadFile(file) {
   add.focus(); if (attachmentBusy || !writable()) return false;
   if (attachmentCount(item) >= 100) { setStatus('This card already has the maximum of 100 attachments.', true); return false; }
   if (!file || typeof file.name !== 'string' || !file.name || !Number.isFinite(file.size) || file.size < 0) { setStatus('Choose a file first.', true); return false; }
   if (file.size > 20 * 1024 * 1024) { setStatus('Attachments must be 20 MiB or smaller.', true); return false; }
   attachmentBusy = true; add.disabled = true; setStatus(`Uploading ${file.name}…`); let uploaded = false;
   const form = new FormData(); form.append('file', file);
   try {
    const data = await api(currentRoot + '/items/' + encodeURIComponent(item.id) + '/attachments', {method:'POST', headers:{'X-CSRF-Token':session.csrf,'Idempotency-Key':requestKey()}, body:form});
    if (!validAttachments([data]) || data.item_id !== item.id) throw new Error('Attachment response is invalid. Refresh to retry.');
    if (board !== currentBoard || root !== currentRoot || !section.isConnected) return false;
    // Without the current list there is nothing to append to, so the count is
    // advanced and the list reloaded rather than invented from one response.
    if (attachmentsLoaded(item)) setItemAttachments(item, [...item.attachments.filter(value => value.id !== data.id), data]);
    else { item.attachment_count = attachmentCount(item) + 1; void ensureAttachments(item); }
    renderList(); renderContent(); setStatus('Attachment uploaded.'); uploaded = true;
   } catch (error) { if (section.isConnected) setStatus(error.message, true); }
   finally { attachmentBusy = false; if (section.isConnected) { add.disabled = !writable(); renderControls(); if (!add.disabled) add.focus(); } }
   return uploaded;
  }
  async function uploadFiles(files) {
   if (attachmentBusy || !writable()) return; const selected = Array.from(files || []).filter(Boolean); input.value = '';
   if (!selected.length) { setStatus('Choose a file first.', true); add.focus(); return; }
   let uploaded = 0;
   for (const file of selected) { if (!await uploadFile(file)) break; uploaded++; }
   if (uploaded > 1 && section.isConnected) setStatus(`${uploaded} attachments uploaded.`);
  }
  input.addEventListener('change', () => { void uploadFiles(input.files ? [input.files[0]] : []); });
  input.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); if (section.isConnected) add.focus(); });
  const clearAttachmentDrop = () => { section.classList.remove('attachment-drop-active'); hint.hidden = true; };
  const showAttachmentDrop = event => {
   if (!isFileTransfer(event.dataTransfer)) return; event.preventDefault(); event.stopPropagation();
   if (writable() && !attachmentBusy) { event.dataTransfer.dropEffect = 'copy'; section.classList.add('attachment-drop-active'); hint.hidden = false; } else { event.dataTransfer.dropEffect = 'none'; clearAttachmentDrop(); }
  };
  section.addEventListener('dragenter', showAttachmentDrop); section.addEventListener('dragover', showAttachmentDrop);
  section.addEventListener('dragleave', event => { if (!event.relatedTarget || !(event.relatedTarget instanceof Node) || !section.contains(event.relatedTarget)) clearAttachmentDrop(); });
  section.addEventListener('drop', event => { if (!isFileTransfer(event.dataTransfer)) return; event.preventDefault(); event.stopPropagation(); clearAttachmentDrop(); if (writable() && !attachmentBusy) void uploadFiles(event.dataTransfer.files); });
 } else heading.append(headingTitle);
 section.append(heading, status, list); fields.append(section); renderList();
}
function buildItemEditor(fields, item, draft, readOnly, context, titleHost) {
 if (item.id && titleHost) titleHost.append(' ', helpPopover(`Card ID: ${item.id}\nRevision: ${item.revision}`, 'Work item details'));
 const layout = el('div', undefined, 'item-editor-layout'); const primary = el('div', undefined, 'item-editor-primary'); const controls = el('div', undefined, 'item-editor-controls'); layout.append(primary, controls); fields.append(layout);
 const title = field(primary, 'title', 'Title', draft?.title ?? item.title); title.required = true; title.maxLength = 240;
 markdownEditor(primary, 'description', 'Description', draft?.description ?? item.description, 16000, readOnly, true);
 multiSelect(controls, 'assignee', 'Assignee', [['', 'Unassigned'], ...board.members.map(m => [m.subject, memberName(m.subject)])], [draft?.assignee ?? item.assignee], undefined, undefined, {single:true});
 multiSelect(controls, 'labels', 'Labels', board.labels.map(label => [label.name, label.name]), draft?.labels ?? item.labels, (chip, value) => { const label = labelInfo(value); chip.style.backgroundColor = label.color; chip.style.color = labelForeground(label.color); chip.classList.add('label-badge'); }, 'Use Edit to add labels and × to remove them. Manage available labels from the Labels view.');
 const selectedProjects = draft?.project_ids ?? itemProjectIDs(item); multiSelect(controls, 'project_id', 'Project', [['', 'No project'], ...board.projects.map(p => [p.id, p.name])], selectedProjects.length ? selectedProjects : [''], undefined, 'Choose one or more projects to classify this work item. Leave No project selected to keep it unclassified.', {emptyValue:''});
 multiSelect(controls, 'sprint_ids', 'Open sprints', board.sprints.filter(s => s.state !== 'closed').map(s => [s.id, `${s.name} (${s.state})`]), draft?.sprint_ids ?? item.sprint_ids, undefined, 'Select no open sprint to keep unfinished work in the backlog. One item may span several sprints without creating duplicate cards.');
 const closed = board.closed_scope.filter(s => s.item_id === item.id).map(scope => board.sprints.find(s => s.id === scope.sprint_id)?.name || scope.sprint_id);
 if (closed.length) controls.append(el('p', 'Closed sprint history (read-only): ' + closed.join(', '), 'help'));
 multiSelect(controls, 'dependencies', 'Depends on', board.items.filter(i => i.id !== item.id).map(i => [i.id, i.title]), draft?.dependencies ?? item.dependencies);
 if (item.id) {
  const itemLinks = board.links.filter(link => link.items.includes(item.id));
  const linkPicker = multiSelect(controls, 'link_ids', 'GitLab links', board.links.map(link => [link.id, linkDisplayName(link)]), draft?.link_ids ?? itemLinks.map(link => link.id), undefined, 'Select registered merge requests to associate with this card. Paste a new MR URL below or use Add link when it is not listed.');
  if (!readOnly) inlineGitLabPaste(linkPicker.group, item, readOnly, context);
  const linkActions = el('div', undefined, 'actions');
  if (!readOnly) { const add = writeButton('Add link', () => addGitLabLink(item, context)); add.dataset.gitlabWrite = 'true'; add.disabled = !gitLabWritable(); linkActions.append(add); }
  else if (itemLinks.length) linkActions.append(button('View observations', () => { if (context.mode === 'modal') $('editor').close(); showLinks(item); }));
  if (linkActions.childElementCount) controls.append(linkActions);
 }
 controls.append(el('hr', undefined, 'item-editor-divider'));
 field(controls, 'column_id', 'Move to', draft?.column_id ?? item.column_id, 'text', board.columns.map(c => [c.id, c.name]));
 if (item.id && !item.archived && !readOnly) {
  const archive = writeButton('Archive item', () => archiveItem(item, context), 'danger'); archive.dataset.itemFooter = 'true'; archive.dataset.write = 'true'; archive.classList.add('archive-footer'); const footer = context.footer || context.form.querySelector('.dialog-foot'); const cancel = footer?.querySelector('#cancel,.detail-cancel'); if (footer) footer.insertBefore(archive, cancel || footer.lastElementChild);
 }
 if (item.id) { renderItemAttachments(primary, item, readOnly); renderItemComments(primary, item); }
}
function createDetailPane() { const pane = el('aside', undefined, 'item-detail-pane'); pane.hidden = true; pane.setAttribute('aria-label', 'Selected work item'); detailPane = pane; return pane; }
function syncListSelection() { document.querySelectorAll('.list-row').forEach(row => { const selected = row.dataset.item === selectedItemID; row.classList.toggle('is-selected', selected); if (selected) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current'); }); }
function updateDetailPaneVisibility() {
 if (!detailPane) return; const open = !!detailState && detailState.pane === detailPane && !!selectedItemID && detailState.form?.isConnected; detailPane.hidden = !open; detailPane.parentElement?.classList.toggle('has-detail', open); syncListSelection();
}
function detailDraftIsDirty(state) {
 if (!state?.form?.isConnected) return false; let current; try { current = itemEditorDraft(state.form); } catch { return true; }
 return JSON.stringify(current) !== JSON.stringify(state.initialDraft) || [...state.form.querySelectorAll('[data-comment-control]')].some(input => String(input.value || '').trim());
}
function detailDiscardAllowed() { return !detailState?.dirty || window.confirm(`Discard unsaved changes to “${detailState.item?.title || 'this item'}”?`); }
function closeDetail({force = false, focus = true} = {}) {
 if (busy) return false; if (!detailState) { selectedItemID = ''; detailPane?.removeAttribute('data-item'); updateDetailPaneVisibility(); return true; }
 if (!force && !detailDiscardAllowed()) return false; const state = detailState; detailState = undefined; selectedItemID = ''; if (state.pane) { state.pane.hidden = true; state.pane.replaceChildren(); state.pane.parentElement?.classList.remove('has-detail'); } syncListSelection(); if (focus) { const target = state.origin?.isConnected ? state.origin : [...document.querySelectorAll('.list-row')].find(row => row.dataset.item === state.itemID); if (target) target.focus({preventScroll:true}); } return true;
}
function selectItem(itemID, origin) {
 if (!board || view !== 'board' || presentation !== 'list') return false; if (detailState?.itemID === itemID) { if (origin) detailState.origin = origin; detailState.form?.querySelector('[name="title"]')?.focus({preventScroll:true}); return true; }
 if (!closeDetail({focus:false})) return false; const item = board.items.find(value => value.id === itemID); if (!item) return false; selectedItemID = itemID; openItemDetail(item, undefined, origin); return true;
}
function updateDetailHeader(item) { if (!detailState?.form || !item) return; detailState.item = item; const title = detailState.form.querySelector('.item-detail-title'); if (title?.firstChild) title.firstChild.nodeValue = item.title; const help = title?.querySelector('.help-popover-content'); if (help) help.textContent = `Card ID: ${item.id}\nRevision: ${item.revision}`; }
function openItemDetail(item, draft, origin) {
 if (!detailPane) return; const readOnly = board.role === 'viewer' || item.archived; const form = el('form', undefined, 'item-detail-form'); const heading = el('div', undefined, 'item-detail-head'); const title = el('h2', item.title, 'item-detail-title'); const actions = el('div', undefined, 'item-detail-head-actions'); const close = button('×', () => closeDetail(), 'item-detail-close'); close.setAttribute('aria-label', 'Close item details'); actions.append(close); heading.append(title, actions);
 const fields = el('div', undefined, 'item-detail-fields'); const error = el('p', '', 'item-detail-error'); error.hidden = true; error.setAttribute('role', 'alert'); const footer = el('div', undefined, 'item-detail-footer'); const cancel = button('Cancel', () => closeDetail(), 'detail-cancel'); const save = button('Save changes', undefined, 'primary'); save.type = 'submit'; save.dataset.write = 'true'; footer.append(cancel, save); form.append(heading, fields, error, footer); detailPane.replaceChildren(form); detailPane.hidden = false;
 const context = {mode:'detail', form, footer, origin}; buildItemEditor(fields, item, draft, readOnly, context, title); if (readOnly) { fields.querySelectorAll('input:not([data-comment-control]),textarea:not([data-comment-control]),select:not([data-comment-control])').forEach(input => { input.disabled = true; }); fields.querySelectorAll('[data-multi-edit],[data-multi-remove]').forEach(input => { input.disabled = true; }); } save.hidden = readOnly;
 const revision = board.workspace.revision; let pending, key; const state = detailState = {itemID:item.id, item, form, pane:detailPane, origin, dirty:false, initialDraft:null}; const updateDirty = () => { if (detailState === state) state.dirty = detailDraftIsDirty(state); }; form.addEventListener('input', updateDirty); form.addEventListener('change', updateDirty); state.initialDraft = itemEditorDraft(form); updateDetailPaneVisibility();
 form.addEventListener('submit', async event => {
  event.preventDefault(); if (readOnly || busy || detailState !== state) return; error.textContent = ''; error.hidden = true; save.disabled = true; cancel.disabled = true; close.disabled = true; const data = new FormData(form); const command = {revision, ...(() => { const desired = data.getAll('link_ids'); state.desiredLinkIDs = desired; return {kind:'item.update', target:item.id, item:{...item, project_id:undefined, title:String(data.get('title') || '').trim(), description:data.get('description'), column_id:data.get('column_id'), project_ids:data.getAll('project_id').filter(Boolean), sprint_ids:data.getAll('sprint_ids'), assignee:data.get('assignee'), labels:data.getAll('labels'), dependencies:data.getAll('dependencies')}}; })()}; const serialized = JSON.stringify(command); if (pending !== serialized) { key = requestKey(); pending = serialized; }
  try { await change(command, key); await reconcileItemLinks(item.id, state.desiredLinkIDs || []); if (detailState !== state || !board) return; const latest = board.items.find(value => value.id === item.id); if (!latest) { closeDetail({force:true}); return; } state.item = latest; state.initialDraft = itemEditorDraft(form); state.dirty = false; updateDetailHeader(latest); notice('Changes saved.'); }
  catch (err) { if (detailState === state) { state.dirty = true; error.textContent = `${err.message} Your input is retained. For a revision conflict, copy your changes, close, refresh, and reopen before retrying.`; error.hidden = false; } }
  finally { if (detailState === state && form.isConnected) { save.disabled = false; cancel.disabled = false; close.disabled = false; renderControls(); } }
 });
 const titleInput = form.querySelector('[name="title"]'); if (titleInput) titleInput.focus({preventScroll:true});
}
function reopenItemEditor(item, draft, mode, origin) { if (mode === 'detail') openItemDetail(item, draft, origin); else editItemModal(item, draft); }
function editItemModal(item, draft) {
 const existing = !!item; const readOnly = board.role === 'viewer' || item?.archived; let desiredLinkIDs; const project = $('project').value; const projectIDs = ['all', 'none'].includes(project) ? [] : [project]; item ||= {title:'', description:'', column_id:board.columns[0].id, project_id:projectIDs[0] || '', project_ids:projectIDs, sprint_ids:[], assignee:'', labels:[], dependencies:[]}; const context = {mode:'modal', form:$('editor-form')};
 openEditor(existing ? 'Work item' : 'Create work item', fields => { context.form = $('editor-form'); buildItemEditor(fields, item, draft, readOnly, context, $('editor-title')); }, data => { if (existing) desiredLinkIDs = data.getAll('link_ids'); return {kind:existing ? 'item.update' : 'item.create', target:item.id || '', item:{...item, project_id:undefined, title:data.get('title').trim(), description:data.get('description'), column_id:data.get('column_id'), project_ids:data.getAll('project_id').filter(Boolean), sprint_ids:data.getAll('sprint_ids'), assignee:data.get('assignee'), labels:data.getAll('labels'), dependencies:data.getAll('dependencies')}}; }, readOnly, existing ? () => reconcileItemLinks(item.id, desiredLinkIDs || []) : undefined);
}
function editItem(item, draft) { if (item && view === 'board' && presentation === 'list') return selectItem(item.id); return editItemModal(item, draft); }
function archiveItem(item, context) {
 if (context?.mode === 'modal') closeEditor();
 openEditor('Archive work item', fields => {
  fields.append(el('p', `Archive “${item.title}” and remove it from all open sprints? History is retained and the item can be restored. Unsaved editor changes will not be applied.`));
  field(fields, 'reason', 'Archive rationale (optional)', '', 'textarea').maxLength = 4000;
 }, data => ({kind:'item.archive', target:item.id, reason:data.get('reason')}), false, context?.mode === 'detail' ? () => closeDetail({force:true, focus:true}) : undefined);
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
function integrationProjectChips(projectIDs) {
 const catalog = new Map(integrationCatalog.map(project => [String(project.id), project]));
 const chips = el('div', undefined, 'tags integration-project-chips'); chips.setAttribute('aria-label', 'Approved GitLab projects');
 projectIDs.forEach(id => { const project = catalog.get(String(id)); const label = project ? gitlabProjectLabel(project) : `GitLab project #${id}`; const chip = el('span', label, 'badge integration-project-chip'); chip.title = label; chips.append(chip); });
 return chips;
}
function openProject(project) {
 if (!board || !project || busy || loading || integrationFormOpen) return;
 if (detailState && !closeDetail({focus:false})) return;
 view = 'board'; presentation = 'list'; $('project').value = project.id; $('scope').value = 'all'; $('assignee').value = 'all'; $('label').value = 'all'; $('search').value = ''; render(); persistPlanningURL();
}
function renderProjectRows(list, count) {
 const query = projectSearch.trim().toLowerCase(); const matches = board.projects.filter(project => { if (!project.name.toLowerCase().includes(query)) return false; if (projectAssigneeFilter === 'all' && projectLabelFilter === 'all') return true; return board.items.some(item => { if (item.archived || !itemProjectIDs(item).includes(project.id)) return false; if (projectAssigneeFilter !== 'all' && (projectAssigneeFilter === 'none' ? item.assignee : item.assignee !== projectAssigneeFilter)) return false; const labels = item.labels || []; if (projectLabelFilter !== 'all' && (projectLabelFilter === 'none' ? labels.length : !labels.includes(projectLabelFilter))) return false; return true; }); }); if (count) count.textContent = `${matches.length} project${matches.length === 1 ? '' : 's'}`; list.replaceChildren();
 if (!matches.length) { const assignee = projectAssigneeFilter === 'none' ? 'Unassigned' : memberName(projectAssigneeFilter); const label = projectLabelFilter === 'none' ? 'No labels' : projectLabelFilter; const message = !query && projectAssigneeFilter === 'all' && projectLabelFilter === 'all' ? 'No projects yet. Items can remain unclassified.' : query && projectAssigneeFilter === 'all' && projectLabelFilter === 'all' ? `No projects match “${projectSearch.trim()}”.` : !query && projectAssigneeFilter !== 'all' && projectLabelFilter === 'all' ? `No projects match assignee “${assignee}”.` : !query && projectAssigneeFilter === 'all' && projectLabelFilter !== 'all' ? `No projects match label “${label}”.` : 'No projects match the current filters.'; list.append(el('p', message, 'empty')); return; }
 matches.forEach(project => { const row = el('div', undefined, 'setup-row maintenance-row'); const info = el('div', undefined, 'maintenance-row-info'); info.append(el('strong', project.name)); const actions = el('div', undefined, 'actions'); const open = actionIconButton('View scope', '◎', () => openProject(project)); open.disabled = busy || loading || integrationFormOpen; const edit = writeIconButton('Edit project', '✎', () => editProject(project)); actions.append(open, edit); row.append(info, actions); list.append(row); });
}
function renderProjects(content) {
 const approvedIDs = board.integration?.projects || [];
 if (!integrationFormOpen && board.connector_instance && approvedIDs.length && !integrationCatalogLoaded && !integrationCatalogLoading) void loadIntegrationCatalog();
 const sections = el('div', undefined, 'maintenance-sections');
 const integration = el('section', undefined, 'maintenance-section');
 const integrationHead = el('div', undefined, 'section-head'); integrationHead.append(el('h2', 'GitLab integration'));
 if (integrationFormOpen) {
  integration.append(integrationHead, renderIntegrationForm());
 } else {
  const edit = writeButton('Edit integration', editIntegration); edit.dataset.write = 'true'; integrationHead.append(edit);
  const configured = board.connector_instance || 'Not configured'; const approved = approvedIDs.length;
  integration.append(integrationHead, el('p', `Operator-configured GitLab instance: ${configured}`, 'help'), el('p', `${approved} approved GitLab project${approved === 1 ? '' : 's'}.`, 'help'));
  if (approved) integration.append(integrationProjectChips(approvedIDs));
  if (integrationCatalogLoading) integration.append(el('p', 'Loading approved GitLab project names…', 'help'));
  if (integrationCatalogError) integration.append(el('p', `Project names are unavailable; approved IDs remain visible. ${integrationCatalogError}`, 'help'));
  if (!board.connector_instance) integration.append(el('p', 'Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN to enable the connector.', 'help'));
 }
 const projects = el('section', undefined, 'workspace-projects'); const projectHead = el('div', undefined, 'section-head'); const newProject = writeButton('＋ New project', () => editProject(), 'primary'); newProject.dataset.write = 'true'; projectHead.append(el('h2', 'Workspace projects'), newProject);
 const projectFilters = el('div', undefined, 'project-filter-bar'); const projectFilterControls = el('div', undefined, 'actions'); const assigneeFilter = el('select'); assigneeFilter.setAttribute('aria-label', 'Assignee'); options(assigneeFilter, [['all', 'Any assignee'], ['none', 'Unassigned'], ...board.members.map(member => [member.subject, memberName(member.subject)])], projectAssigneeFilter); if (!assigneeFilter.value) { projectAssigneeFilter = 'all'; assigneeFilter.value = 'all'; } const assigneeLabel = el('label', 'Assignee', 'project-assignee-filter'); assigneeLabel.append(assigneeFilter); const labelFilter = el('select'); labelFilter.setAttribute('aria-label', 'Label'); options(labelFilter, [['all', 'Any label'], ['none', 'No labels'], ...board.labels.map(label => [label.name, label.name])], projectLabelFilter); if (!labelFilter.value) { projectLabelFilter = 'all'; labelFilter.value = 'all'; } const labelLabel = el('label', 'Label', 'project-label-filter'); labelLabel.append(labelFilter); const filter = el('label', 'Search', 'project-name-filter'); const input = el('input'); input.type = 'search'; input.value = projectSearch; input.placeholder = 'Find projects…'; input.maxLength = 120; input.setAttribute('aria-label', 'Search'); filter.append(input); projectFilterControls.append(assigneeLabel, labelLabel, filter); const projectCount = el('span', undefined, 'project-filter-count muted'); projectCount.setAttribute('aria-live', 'polite'); projectFilters.append(projectFilterControls, projectCount);
 projects.append(projectHead, projectFilters, el('p', 'Projects classify work in this workspace. Boards, sprint scope, WIP and permissions stay workspace-wide. Assignee and Label filters match projects with current non-archived work matching the selected fields; Unassigned and No labels match empty values.', 'help'));
 const list = el('div', undefined, 'maintenance-list'); renderProjectRows(list, projectCount); input.addEventListener('input', () => { projectSearch = input.value; renderProjectRows(list, projectCount); }); assigneeFilter.addEventListener('change', () => { projectAssigneeFilter = assigneeFilter.value; renderProjectRows(list, projectCount); }); labelFilter.addEventListener('change', () => { projectLabelFilter = labelFilter.value; renderProjectRows(list, projectCount); }); projects.append(list);
 sections.append(integration, projects); content.append(sections);
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
 const list = el('div', undefined, 'label-maintenance-list'); board.labels.forEach(label => { const row = el('article', undefined, 'setup-row label-maintenance-row'); const summary = el('div', undefined, 'label-maintenance-summary'); const usage = board.items.filter(item => item.labels.includes(label.name)).length; summary.append(labelBadge(label.name), el('small', `${usage} card${usage === 1 ? '' : 's'}`, 'muted')); const actions = el('div', undefined, 'actions'); const rename = writeIconButton('Rename', '✎', () => editLabel(label)); const remove = writeIconButton('Delete…', '×', () => deleteLabel(label), 'danger'); actions.append(rename, remove); row.append(summary, actions); list.append(row); }); content.append(list);
}
const MEMBER_ROLE_ENTRIES = [['viewer', 'Viewer'], ['member', 'Member'], ['admin', 'Admin']];
function memberRoleLabel(role) { return MEMBER_ROLE_ENTRIES.find(([value]) => value === role)?.[1] || role; }
function memberRoleChip(role) {
 const roleClass = MEMBER_ROLE_ENTRIES.some(([value]) => value === role) ? role : 'unknown'; const chip = el('span', memberRoleLabel(role), `badge member-role member-role-${roleClass}`); chip.setAttribute('aria-label', `Role: ${memberRoleLabel(role)}`); return chip;
}
function memberIdentityView(member) {
 const info = memberListingInfo(member); const identity = el('div', undefined, 'member-identity'); identity.append(avatarView(info.name, info.avatarURL));
 const copy = el('div', undefined, 'member-identity-copy'); copy.append(el('strong', info.name)); const username = String(member.username || '').trim(); const meta = el('div', undefined, 'member-identity-meta'); if (username) meta.append(el('small', `@${username}`, 'muted')); meta.append(memberRoleChip(member.role)); copy.append(meta); identity.append(copy); return identity;
}
function editMember(member) {
 if (!adminWritable()) return;
 $('editor').close(); openEditor('Edit workspace member', fields => {
  const subject = field(fields, 'subject', 'GitLab subject', member.subject); subject.readOnly = true; subject.setAttribute('aria-readonly', 'true');
  const name = field(fields, 'name', 'Workspace name', member.name || ''); name.maxLength = 120; name.placeholder = 'Optional admin-maintained name';
  field(fields, 'role', 'Workspace role', member.role, 'text', MEMBER_ROLE_ENTRIES);
  fields.append(el('p', 'Leave the workspace name blank to use the available GitLab profile name.', 'help'));
 }, data => ({kind: 'member.save', target: member.subject, member: {subject: member.subject, name: data.get('name').trim(), role: data.get('role')}}));
 $('save').textContent = 'Save member';
}
function removeMember(member) {
 if (!adminWritable()) return;
 const assigned = board.items.filter(item => item.assignee === member.subject).length;
 $('editor').close(); openEditor('Remove workspace member', fields => {
  fields.append(memberIdentityView(member), el('p', `Remove ${memberListingInfo(member).name} from this workspace? Workspace history is retained.`));
  if (assigned) fields.append(el('p', `This member is assigned to ${assigned} card${assigned === 1 ? '' : 's'}. Reassign those cards before removing the member.`, 'help'));
 }, () => ({kind: 'member.delete', target: member.subject}));
 $('save').textContent = 'Remove member';
}
function addMember() {
 if (!adminWritable()) return;
 const currentBoard = board, currentRoot = root;
 $('editor').close(); openEditor('Add workspace member', fields => {
  fields.append(el('p', 'Search active users from the configured GitLab instance. Adding a user grants access to this workspace only; it does not change GitLab permissions.', 'help'));
  let searchTimer, searchGeneration = 0, nameEdited = false;
  const usersBySubject = new Map();
  let subjectInput, nameInput;
  const syncSelectedUser = values => {
   const subject = String(values[0] || '');
   subjectInput.value = subject;
   if (!nameEdited) nameInput.value = usersBySubject.get(subject)?.name || '';
  };
  const queueUsers = (query, controls) => {
   if (searchTimer) clearTimeout(searchTimer); const generation = ++searchGeneration; const search = query.trim(); controls.setStatus(search ? 'Searching GitLab…' : 'Loading GitLab users…');
   searchTimer = setTimeout(async () => {
    try {
     const users = await loadGitLabUsers(currentRoot, search);
     if (generation !== searchGeneration || board !== currentBoard || root !== currentRoot) return;
     users.forEach(user => usersBySubject.set(String(user.id), user));
     const selected = controls.selected(); const entries = memberUserEntries(users, selected); controls.setEntries(entries, selected); controls.setStatus(entries.length ? '' : 'No available GitLab users match this search.');
    } catch (error) {
     if (generation === searchGeneration && board === currentBoard && root === currentRoot) controls.setStatus(error.message || String(error));
    }
   }, search ? 250 : 0);
  };
  multiSelect(fields, 'gitlab_user', 'GitLab user', [], [], undefined, 'Only users returned by the configured server-side GitLab connector can be added. Existing workspace members are omitted.', {single:true, onOpen:queueUsers, onFilter:queueUsers, onChange:syncSelectedUser});
  subjectInput = field(fields, 'subject', 'GitLab subject', ''); subjectInput.readOnly = true; subjectInput.required = true; subjectInput.placeholder = 'Select a GitLab user'; subjectInput.setAttribute('aria-readonly', 'true');
  nameInput = field(fields, 'name', 'Workspace name', ''); nameInput.maxLength = 120; nameInput.placeholder = 'Defaults to the GitLab profile name'; nameInput.addEventListener('input', () => { nameEdited = true; });
  field(fields, 'role', 'Workspace role', 'member', 'text', MEMBER_ROLE_ENTRIES);
  if (!currentBoard.connector_instance) fields.append(el('p', 'A GitLab read connector is not configured. Ask the operator to set FLUX_GITLAB_URL and FLUX_GITLAB_SERVICE_TOKEN.', 'help'));
 }, data => {
  const subject = String(data.get('gitlab_user') || '').trim(); if (!/^[1-9][0-9]*$/.test(subject) || !Number.isSafeInteger(Number(subject))) throw new Error('Select an available GitLab user.');
  return {kind: 'member.save', member: {subject, role: data.get('role'), name: String(data.get('name') || '').trim()}};
 });
 $('save').textContent = 'Add member';
}
function renderMembers(content) {
 $('count').textContent = `${board.members.length} member${board.members.length === 1 ? '' : 's'}`;
 const heading = el('div', undefined, 'section-head'); heading.append(el('h2', 'Workspace members')); if (board.role === 'admin') heading.append(adminButton('＋ Add member', addMember, 'primary'));
 content.append(heading, el('p', board.role === 'admin' ? 'Manage workspace access and roles. OAuth supplies the signed-in user’s GitLab profile; other numeric members need the server-side read connector for names, usernames, and avatars. Bootstrap, non-GitLab, or unavailable profiles may not have a username or avatar.' : 'Review workspace members and roles. Only workspace admins can add members, remove members, change roles, or maintain display names.', 'help'));
 if (!board.members.length) { content.append(el('p', 'No workspace members yet.', 'empty')); return; }
 const list = el('div', undefined, 'maintenance-list'); board.members.forEach(member => { const row = el('div', undefined, 'setup-row maintenance-row'); const info = el('div', undefined, 'maintenance-row-info'); info.append(memberIdentityView(member)); if (board.role === 'admin') { const actions = el('div', undefined, 'actions'); actions.append(adminIconButton('Edit member', '✎', () => editMember(member)), adminIconButton('Remove member', '−', () => removeMember(member), 'danger')); row.append(info, actions); } else row.append(info); list.append(row); }); content.append(list);
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
function gitLabUserLabel(user) {
 const name = String(user.name || '').trim() || String(user.username || '').trim() || `GitLab user ${user.id}`; const username = String(user.username || '').trim();
 return `${name}${username && username !== name ? ` · @${username}` : ''} (#${user.id})`;
}
function validGitLabUserCatalog(data) { return Array.isArray(data) && data.every(user => user && Number.isSafeInteger(user.id) && user.id > 0 && typeof user.username === 'string' && user.username.trim() && typeof user.name === 'string' && user.name.trim() && (user.avatar_url === undefined || typeof user.avatar_url === 'string')); }
function memberUserEntries(users, selected = []) {
 const entries = [], seen = new Set(), existing = new Set(board.members.map(member => member.subject)), selectedSet = new Set(selected.map(String));
 users.forEach(user => { const value = String(user.id); if (seen.has(value) || existing.has(value) && !selectedSet.has(value)) return; seen.add(value); entries.push([value, gitLabUserLabel(user)]); });
 selected.forEach(value => { value = String(value); if (seen.has(value)) return; seen.add(value); entries.push([value, `GitLab user #${value} (currently selected)`]); });
 return entries;
}
async function loadGitLabUsers(currentRoot, search = '') {
 const params = new URLSearchParams({search}); const data = await api(currentRoot + '/gitlab/users?' + params);
 if (!validGitLabUserCatalog(data)) throw new Error('GitLab user results are invalid. Refresh to retry.');
 return data;
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
function editIntegration() {
 if (!board || busy || loading || integrationFormOpen) return;
 integrationFormOpen = true; integrationCatalog = []; integrationCatalogLoaded = false; integrationCatalogError = '';
 integrationCatalogLoading = false; integrationCatalogRequest++;
 if (board.connector_instance) void loadIntegrationCatalog(); else render();
}
async function loadIntegrationCatalog() {
 if (!board || integrationCatalogLoading || view !== 'projects') return;
 const currentBoard = board, currentRoot = root, request = ++integrationCatalogRequest; integrationCatalogLoading = true; integrationCatalogError = '';
 if (integrationFormOpen) { render(); notice('Loading available GitLab projects…'); }
 try {
  const catalog = await loadGitLabProjects(currentRoot);
  if (request !== integrationCatalogRequest || board !== currentBoard || root !== currentRoot) return;
  integrationCatalog = catalog; integrationCatalogLoaded = true;
 } catch (error) {
  if (request !== integrationCatalogRequest || board !== currentBoard || root !== currentRoot) return;
  integrationCatalogError = error.message; integrationCatalogLoaded = true;
 } finally {
  if (request !== integrationCatalogRequest) return;
  integrationCatalogLoading = false;
  if (board === currentBoard && root === currentRoot && view === 'projects') { if (integrationFormOpen) notice(''); render(); }
 }
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
 const actions = el('div', undefined, 'dialog-foot inline-maintenance-actions'); const cancel = button('Cancel', () => { integrationFormOpen = false; integrationCatalogError = ''; integrationCatalogLoading = false; integrationCatalogRequest++; render(); }); actions.append(cancel);
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
   integrationCatalogError = ''; integrationCatalogLoading = false; integrationCatalogRequest++; render();
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
   const row = el('article', undefined, 'setup-row'); row.dataset.linkId = link.id; const obs = link.observation; const linkRow = el('div', undefined, 'card-links'); linkRow.append(cardLinkView(link)); const pipelineLink = pipelineLinkView(link); if (pipelineLink) linkRow.append(pipelineLink); row.append(linkRow);
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
   refreshButton.disabled = refreshLinkDisabled(link) || !ready;
   actions.append(refreshButton);
   if (link.next_refresh) { const nextRefresh = el('p', '', 'help'); nextRefresh.dataset.observation = 'next-refresh'; nextRefresh.hidden = Date.parse(link.next_refresh) <= Date.now(); if (!nextRefresh.hidden) nextRefresh.textContent = `Next refresh after ${new Date(link.next_refresh).toLocaleTimeString()}. The refresh control becomes available after that time.`; row.append(nextRefresh); }
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
$('editor').addEventListener('cancel', e => { e.preventDefault(); if (e.target === $('editor') && !busy) closeEditor(); });
$('editor').addEventListener('click', e => { if (!busy && e.target === $('editor')) closeEditor(); });
document.addEventListener('pointerover', e => { const target = observationIconTarget(e.target); if (target && !(e.relatedTarget instanceof Node && target.contains(e.relatedTarget))) { observationTooltipTarget = target; positionObservationTooltip(target); } });
document.addEventListener('pointerout', e => { const target = observationIconTarget(e.target); if (!target || (e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) || target.matches(':hover') || target.contains(document.activeElement)) return; if (observationTooltipTarget === target) observationTooltipTarget = undefined; });
document.addEventListener('focusin', e => { const target = observationIconTarget(e.target); if (target) { observationTooltipTarget = target; positionObservationTooltip(target); } });
document.addEventListener('focusout', e => { const target = observationIconTarget(e.target); if (!target || (e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) || target.matches(':hover')) return; if (observationTooltipTarget === target) observationTooltipTarget = undefined; });
window.addEventListener('resize', repositionObservationTooltip); document.addEventListener('scroll', repositionObservationTooltip, true);
document.addEventListener('pointerover', e => { const target = attachmentLinkTarget(e.target); if (target && !(e.relatedTarget instanceof Node && target.contains(e.relatedTarget))) showAttachmentTooltip(target, e.target); });
document.addEventListener('pointerout', e => { const target = attachmentLinkTarget(e.target); if (!target || (e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) || target.matches(':hover') || target.contains(document.activeElement)) return; hideAttachmentTooltip(target); });
document.addEventListener('focusin', e => { const target = attachmentLinkTarget(e.target); if (target) showAttachmentTooltip(target, e.target); });
document.addEventListener('focusout', e => { const target = attachmentLinkTarget(e.target); if (!target || (e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) || target.matches(':hover')) return; hideAttachmentTooltip(target); });
window.addEventListener('resize', repositionAttachmentTooltip); document.addEventListener('scroll', repositionAttachmentTooltip, true);
document.addEventListener('pointerdown', e => { document.querySelectorAll('.attachment-actions[open],.card-attachments[open]').forEach(menu => { if (!menu.contains(e.target)) menu.open = false; }); const editor = $('editor'); if (!editor.open || busy) return; const r = editor.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeEditor(); });
function setPresentation(next) { if (!['board', 'list'].includes(next) || next === presentation || loading || busy || integrationFormOpen) return; if (detailState && !closeDetail({focus:false})) return; presentation = next; render(); persistPlanningURL(); }
$('dismiss').onclick = $('cancel').onclick = () => { if (!busy) closeEditor(); };
$('proposals').onclick = () => showProposals();
$('new-item').onclick = () => editItem(); $('columns').onclick = setupBoard; $('new-workspace').onclick = showWorkspaceCreate; $('refresh').onclick = refresh; $('planning-refresh').onclick = refresh;
$('presentation-board').onclick = () => setPresentation('board'); $('presentation-list').onclick = () => setPresentation('list');
$('scope').onchange = () => { render(); persistPlanningURL(); };
$('label').onchange = $('search').oninput = renderContent;
$('project').onchange = () => { resetBurndown(); render(); if (!burndownRequests.size) $('content').setAttribute('aria-busy', 'false'); persistPlanningURL(); };
$('assignee').onchange = () => { resetBurndown(); render(); if (!burndownRequests.size) $('content').setAttribute('aria-busy', 'false'); };
document.addEventListener('keydown', event => { if (event.key !== 'Escape' || !detailState?.pane?.contains(event.target) || $('editor').open) return; const menu = event.target.closest?.('.multi-select-menu'); if (menu && !menu.hidden) return; if (closeDetail()) event.preventDefault(); });
document.querySelectorAll('[data-view]').forEach(b => { b.onclick = async () => { if (loading || busy || integrationFormOpen) return; if (view === 'board' && b.dataset.view !== 'board' && detailState && !closeDetail({focus:false})) return; view = b.dataset.view; if (view === 'history') { try { await loadHistory(true); } catch (e) { notice(e.message, true); } } if (view === 'archive') { try { await loadArchive(true); } catch (e) { notice(e.message, true); } } render(); }; });
async function chooseWorkspace(workspaceID = '') {
 if (busy || loading) return false;
 if (detailState && !closeDetail({focus:false})) { if (board?.workspace?.id) $('workspace').value = board.workspace.id; return false; }
 const selectedID = workspaceID || $('workspace').value;
 if (!workspaces.some(workspace => workspace.id === selectedID)) return false;
 const urlState = pendingPlanningURLState; pendingPlanningURLState = undefined;
 integrationFormOpen = false; integrationCatalog = []; integrationCatalogLoaded = false; integrationCatalogError = ''; integrationCatalogLoading = false; integrationCatalogRequest++;
 clearPlanningChangeNotice(); board = undefined; workspaceGate = 'loading'; updateWorkspaceOptions(selectedID); resetBurndown(); burndownExpanded.clear(); projectSearch = ''; projectAssigneeFilter = 'all'; projectLabelFilter = 'all'; $('project').value = 'all'; $('assignee').value = 'all'; $('label').value = 'all'; $('scope').value = 'active'; $('search').value = ''; root = `/api/v2/workspaces/${encodeURIComponent(selectedID)}`; render();
 const refreshed = await refresh();
 if (!refreshed) { if (urlState && workspaceGate === 'loading') pendingPlanningURLState = urlState; return false; }
 workspaceGate = ''; persistWorkspaceURL(selectedID); if (urlState) applyPlanningURLState(urlState); else persistPlanningURL(); return true;
}
$('workspace').onchange = () => { void chooseWorkspace(); };
let observationPoll = false, observationDigest = '', observationReadAt = 0;
// A digest that only ever reports "unchanged" is indistinguishable from a
// working one, so the board is re-read on a timer regardless of the digest.
// This bounds staleness if the digest ever stops tracking the board payload.
const OBSERVATION_FALLBACK_MS = 120000;
// The poll asks for the workspace revision and an observation digest first. A
// board read follows only when the digest moved, so an idle board costs two
// indexed lookups instead of a full board load every fifteen seconds.
setInterval(async () => {
 if (!board?.refresh_seconds || busy || loading || integrationFormOpen || drag || document.hidden || $('editor').open || observationPoll) return;
 const current = board, path = root; observationPoll = true;
 try {
  const state = await api(path + '/revision');
  if (board !== current || root !== path || busy || loading || integrationFormOpen || drag || $('editor').open) return;
  if (!state || !Number.isSafeInteger(state.revision) || typeof state.role !== 'string') throw new Error('Workspace state response is invalid.');
  if (state.revision !== board.workspace.revision || state.role !== board.role) { showPlanningChangeNotice(state.role !== board.role ? 'Workspace permissions changed elsewhere · Refresh to review' : undefined); return; }
  const digest = String(state.links_digest || '');
  if (observationDigest && digest === observationDigest && Date.now() - observationReadAt < OBSERVATION_FALLBACK_MS) return;
  const next = await api(path + '/board');
  if (board !== current || root !== path || busy || loading || integrationFormOpen || drag || $('editor').open) return;
  if (!next?.workspace || !Array.isArray(next.links)) throw new Error('Observation response is invalid.');
  if (next.workspace.revision !== board.workspace.revision || next.role !== board.role) { showPlanningChangeNotice(next.role !== board.role ? 'Workspace permissions changed elsewhere · Refresh to review' : undefined); return; }
  const currentLinks = new Map(board.links.map(link => [link.id, link])); if (next.links.length !== board.links.length || next.links.some(link => { const current = currentLinks.get(link.id); return !current || linkIdentitySignature(current) !== linkIdentitySignature(link); })) { showPlanningChangeNotice(); return; }
  observationDigest = digest; observationReadAt = Date.now();
  const uiState = captureUIState(); const previousLinks = board.links; board.links = next.links; if (patchObservationUI(previousLinks, board.links)) restoreUIState(uiState);
 } catch (e) { if (board === current && !busy && !integrationFormOpen && !$('editor').open) notice('Observation cache could not be reloaded. Use Refresh to retry.', true); }
 finally { observationPoll = false; }
}, 15000);
setInterval(async () => {
 if (!board || busy || loading || integrationFormOpen || drag || document.hidden || $('editor').open || membershipPoll) return;
 const current = board, selectedID = board.workspace.id, before = workspaceListSignature(workspaces); membershipPoll = true;
 try {
  const next = await loadWorkspaces(selectedID);
  if (board !== current || busy || loading || integrationFormOpen || document.hidden) return;
  if (!next.some(workspace => workspace.id === selectedID)) { enterWorkspaceGate(next.length ? 'select' : 'create', next.length ? 'Workspace access changed. Choose an available workspace.' : 'Workspace access changed. Create a workspace to get started.'); return; }
  if (workspaceListSignature(next) !== before) showPlanningChangeNotice('Workspace membership changed · Refresh to review');
 } catch (e) { if (board === current && !busy && !integrationFormOpen) notice('Workspace access could not be reloaded. Use Refresh to retry.', true); }
 finally { membershipPoll = false; }
}, 30000);
// Local freshness/cooldowns require no additional network requests.
setInterval(() => {
 if (!board) return;
 document.querySelectorAll('[data-refresh-link]').forEach(node => { const link = board.links.find(l => l.id === node.dataset.refreshLink); patchRefreshControl(node, link); });
}, 10000);
renderControls();
(async () => { try {
 session = await api('/api/v2/session'); $('identity').textContent = session.name || session.subject; const next = await loadWorkspaces(''); const preferred = workspacePreference();
 if (!next.length) { pendingPlanningURLState = undefined; workspaceGate = 'create'; persistWorkspaceURL(''); notice('No workspace yet. Create one to get started.'); render(); return; }
 if (preferred && next.some(workspace => workspace.id === preferred)) { await chooseWorkspace(preferred); return; }
 if (preferred) persistWorkspaceURL('');
 if (next.length === 1) { await chooseWorkspace(next[0].id); return; }
 workspaceGate = 'select'; notice('Choose a workspace to continue.'); render();
 } catch (e) { notice(e.message, true); render(); } })();
