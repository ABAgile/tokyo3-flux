// Shared page-frame components. Every view is assembled from these factories,
// so page structure is predictable and memorable:
//
//   #content
//   ├── #planning-frame.page-stack       Board, List and Archive (persistent)
//   │   ├── #project-summary, #sprint-summary
//   │   ├── #planning-filter-slot
//   │   └── #planning-body               .board / .list-detail-layout / .list
//   └── #page-root                       one page root for every other view
//       └── .page-stack[data-content-view]
//           ├── .section-head            title + actions
//           ├── .filter-slot             filter bar + chips (optional)
//           ├── .help                    guidance text (optional)
//           └── body: .panel / .maintenance-list / .empty
//
// No module-level state: every export is a pure factory over its arguments, so
// it is safe to import anywhere.
import {el, options, uid, noAutofill} from './dom.js';

// #content holds exactly one page root. `data-content-view` names the
// composition so a re-render can patch the existing DOM instead of replacing
// it whenever the page kind is unchanged.
function contentRoot(tag, className, contentView) {
 const root = el(tag, undefined, className);
 if (contentView) root.dataset.contentView = contentView;
 return root;
}
// The default page body: one single-column stack of sections with one gap, so
// Projects, Sprints, Members, Labels and History space their sections alike.
function pageStack(contentView) { return contentRoot('div', 'page-stack', contentView); }
// A bordered surface. Variants add their own padding and inner layout.
function panel(className, tag = 'section') { return el(tag, undefined, className ? `panel ${className}` : 'panel'); }

// Page-level section title with optional right-aligned actions.
function sectionHead(title, ...actions) {
 const head = el('div', undefined, 'section-head');
 head.append(el('h2', title), ...actions.filter(Boolean));
 return head;
}
// Subordinate heading for a panel: an h3 title above optional guidance, used by
// the read-only chart panels so their heads match the page heads. `description`
// is either guidance text or a ready-made node.
function panelHead(title, {id, description, className} = {}) {
 const head = el('div', undefined, className ? `section-head ${className}` : 'section-head');
 const heading = el('h3', title); if (id) heading.id = id;
 if (!description) { head.append(heading); return head; }
 // Title and guidance travel together so actions stay on the opposite edge.
 const intro = el('div');
 intro.append(heading, typeof description === 'string' ? helpText(description) : description);
 head.append(intro);
 return head;
}
// Guidance text. `variant` adds a page-specific class beside the shared one.
function helpText(text, variant) { return el('p', text, variant ? `help ${variant}` : 'help'); }
// One inline live region for progress and validation: polite while it reports
// progress, assertive while it carries an error, hidden while it says nothing.
function statusLine(className = 'help') {
 const line = el('p', '', className);
 line.dataset.statusClass = className;
 line.hidden = true;
 line.setAttribute('role', 'status');
 line.setAttribute('aria-live', 'polite');
 return line;
}
// The assertive counterpart: a one-line error region, empty and hidden until a
// write fails. Errors never share a node with progress, so they are announced
// once and stay until the next attempt clears them.
function errorLine(text = '', className = 'error') {
 const line = el('p', text, className);
 line.setAttribute('role', 'alert');
 line.hidden = !text;
 return line;
}
function setErrorText(line, text) { line.textContent = text || ''; line.hidden = !text; }
function setStatusText(line, text, error = false) {
 const base = line.dataset.statusClass || 'help';
 line.textContent = text || '';
 line.className = error ? `${base} error` : base;
 line.hidden = !text;
 line.setAttribute('role', error ? 'alert' : 'status');
}
// Empty states are keyed so the reconciler patches them in place instead of
// rebuilding the surrounding container.
function emptyState(text) { const node = el('p', text, 'empty'); node.dataset.empty = 'true'; return node; }
// The one metric row: large value over its caption, shared by the project lens,
// sprint panels, the delivery trend and burn-down charts.
function metricList(entries, className) {
 const metrics = el('div', undefined, className ? `metrics ${className}` : 'metrics');
 entries.forEach(([value, label]) => {
  const metric = el('span', undefined, 'metric');
  metric.append(el('strong', String(value)), el('span', label));
  metrics.append(metric);
 });
 return metrics;
}

// The only filter container: labeled native controls on the left, a
// right-aligned visible record count. Callers append their controls.
function filterBar() {
 const bar = el('div', undefined, 'filter-bar');
 const controls = el('div', undefined, 'actions');
 const count = el('span', undefined, 'filter-bar-count muted');
 count.setAttribute('aria-live', 'polite');
 bar.append(controls, count);
 return {bar, controls, count};
}
// Add-a-filter select: it adds one value and returns to its All entry. Filter
// controls are standalone page state, never form data, so they are identified
// by a unique id rather than a submitted name.
function filterSelect(title, entries) {
 const select = el('select');
 select.id = uid(`filter-${controlSlug(title)}`);
 select.setAttribute('aria-label', title);
 options(select, entries, 'all');
 const label = el('label', title);
 label.setAttribute('for', select.id);
 label.append(select);
 return {label, select};
}
function filterSearch(title, {value = '', placeholder = '', maxLength = 120} = {}) {
 const input = noAutofill(el('input'));
 input.id = uid(`filter-${controlSlug(title)}`);
 input.type = 'search'; input.value = value; input.placeholder = placeholder; input.maxLength = maxLength;
 input.setAttribute('aria-label', title);
 const label = el('label', title);
 label.setAttribute('for', input.id);
 label.append(input);
 return {label, input};
}
function controlSlug(title) { return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'control'; }
// Removable chips are the authoritative view of a multi-value filter group.
function filterChipRow(ariaLabel) {
 const chips = el('div', undefined, 'filter-chips');
 chips.setAttribute('role', 'group');
 chips.setAttribute('aria-label', ariaLabel);
 chips.hidden = true;
 return chips;
}
// Filter bars live in a slot so the shared planning bar can be relocated
// between hosts rather than duplicated.
function filterSlot(id, ...children) {
 const slot = el('div', undefined, 'filter-slot');
 if (id) slot.id = id;
 slot.append(...children.filter(Boolean));
 return slot;
}

function maintenanceList(className) { return el('div', undefined, className ? `maintenance-list ${className}` : 'maintenance-list'); }
// One row shape for Projects, Members and Labels: identity on the left,
// optional actions on the right.
function maintenanceRow({tag = 'div', className = '', content = [], actions = []} = {}) {
 const row = el(tag, undefined, `setup-row maintenance-row${className ? ` ${className}` : ''}`);
 const info = el('div', undefined, 'maintenance-row-info');
 info.append(...content.filter(Boolean));
 row.append(info);
 const visible = actions.filter(Boolean);
 if (visible.length) { const group = el('div', undefined, 'actions'); group.append(...visible); row.append(group); }
 return row;
}

export {contentRoot, pageStack, panel, sectionHead, panelHead, helpText, statusLine, setStatusText, errorLine, setErrorText, emptyState, metricList,
 filterBar, filterSelect, filterSearch, filterChipRow, filterSlot, maintenanceList, maintenanceRow};
