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
// Each component has a lit template form (`*Template`) and, while imperative
// views remain, a node form that renders the template once. No module-level
// state: every export is a pure factory over its arguments.
import { el, uid, noAutofill } from './dom.js';
import { html, live, nodeOf, nothing, render } from './lit.js';

// #content holds exactly one page root. `data-content-view` names the
// composition so a re-render can patch the existing DOM instead of replacing
// it whenever the page kind is unchanged.
function contentRoot(tag, className, contentView) {
  const root = el(tag, undefined, className);
  if (contentView) root.dataset.contentView = contentView;
  return root;
}
// Renders a view's template into its page root. The root persists while the
// host shows the same view, so lit updates it in place; a new root is filled
// while detached and then replaces the host's content in one insertion.
function renderRoot(host, className, contentView, template, tag = 'div') {
  const current = host.firstElementChild;
  const root =
    current?.dataset.contentView === contentView
      ? current
      : contentRoot(tag, className, contentView);
  render(template, root);
  if (root !== current) host.replaceChildren(root);
  return root;
}
// The default page body: one single-column stack of sections with one gap, so
// Projects, Sprints, Members, Labels and History space their sections alike.
function pageStack(contentView) {
  return contentRoot('div', 'page-stack', contentView);
}
function renderPage(host, contentView, template) {
  return renderRoot(host, 'page-stack', contentView, template);
}
// A bordered surface. Variants add their own padding and inner layout.
function panelTemplate(className, content, tag = 'section') {
  const classes = className ? `panel ${className}` : 'panel';
  return tag === 'article'
    ? html`<article class=${classes}>${content}</article>`
    : html`<section class=${classes}>${content}</section>`;
}
function panel(className, tag = 'section') {
  return el(tag, undefined, className ? `panel ${className}` : 'panel');
}
// Page-level section title with optional right-aligned actions.
function sectionHeadTemplate(title, ...actions) {
  return html`<div class="section-head"><h2>${title}</h2>${actions.filter(Boolean)}</div>`;
}
function sectionHead(title, ...actions) {
  return nodeOf(sectionHeadTemplate(title, ...actions));
}
// Subordinate heading for a panel: an h3 title above optional guidance, used by
// the read-only chart panels so their heads match the page heads. `description`
// is either guidance text or a ready-made template or node.
function panelHeadTemplate(title, { id, description, className } = {}) {
  const classes = className ? `section-head ${className}` : 'section-head';
  const heading = html`<h3 id=${id || nothing}>${title}</h3>`;
  if (!description) return html`<div class=${classes}>${heading}</div>`;
  // Title and guidance travel together so actions stay on the opposite edge.
  const guidance = typeof description === 'string' ? helpTextTemplate(description) : description;
  return html`<div class=${classes}><div>${heading}${guidance}</div></div>`;
}
function panelHead(title, options) {
  return nodeOf(panelHeadTemplate(title, options));
}
// Guidance text. `variant` adds a page-specific class beside the shared one.
function helpTextTemplate(text, variant) {
  return html`<p class=${variant ? `help ${variant}` : 'help'}>${text}</p>`;
}
function helpText(text, variant) {
  return nodeOf(helpTextTemplate(text, variant));
}
// One inline live region for progress and validation: polite while it reports
// progress, assertive while it carries an error, hidden while it says nothing.
// Its class, text and role belong to setStatusText, so the template binds none
// of them after creation.
function statusLineTemplate(className = 'help') {
  return html`<p
    class=${className}
    data-status-class=${className}
    hidden
    role="status"
    aria-live="polite"
  ></p>`;
}
function statusLine(className = 'help') {
  return nodeOf(statusLineTemplate(className));
}
// The assertive counterpart: a one-line error region, empty and hidden until a
// write fails. Errors never share a node with progress, so they are announced
// once and stay until the next attempt clears them.
function errorLineTemplate(text = '', className = 'error') {
  return html`<p class=${className} role="alert" ?hidden=${!text}>${text}</p>`;
}
function errorLine(text = '', className = 'error') {
  const line = el('p', text, className);
  line.setAttribute('role', 'alert');
  line.hidden = !text;
  return line;
}
function setErrorText(line, text) {
  line.textContent = text || '';
  line.hidden = !text;
}
function setStatusText(line, text, error = false) {
  const base = line.dataset.statusClass || 'help';
  line.textContent = text || '';
  line.className = error ? `${base} error` : base;
  line.hidden = !text;
  line.setAttribute('role', error ? 'alert' : 'status');
}
// Empty states are keyed so the reconciler patches them in place instead of
// rebuilding the surrounding container.
function emptyStateTemplate(text) {
  return html`<p class="empty" data-empty="true">${text}</p>`;
}
function emptyState(text) {
  return nodeOf(emptyStateTemplate(text));
}
// The one metric row: large value over its caption, shared by the project lens,
// sprint panels, the delivery trend and burn-down charts.
function metricListTemplate(entries, className) {
  return html`<div class=${className ? `metrics ${className}` : 'metrics'}>
    ${entries.map(
      ([value, label]) =>
        html`<span class="metric"><strong>${String(value)}</strong><span>${label}</span></span>`,
    )}
  </div>`;
}
function metricList(entries, className) {
  return nodeOf(metricListTemplate(entries, className));
}

// The only filter container: labeled native controls on the left, a
// right-aligned visible record count.
function filterBarTemplate(controls, count = '') {
  return html`<div class="filter-bar">
    <div class="actions">${controls}</div>
    <span class="filter-bar-count muted" aria-live="polite">${count}</span>
  </div>`;
}
// Imperative form: callers append their controls and write the count.
function filterBar() {
  const bar = nodeOf(filterBarTemplate());
  return { bar, controls: bar.firstElementChild, count: bar.lastElementChild };
}
// Filter controls are standalone page state, never form data, so they are
// identified by a unique id rather than a submitted name. Ids are generated
// once per control and passed in, so a re-render keeps them.
function filterControlID(title) {
  return uid(`filter-${controlSlug(title)}`);
}
// Add-a-filter select: it adds one value and returns to its All entry.
function filterSelectTemplate(title, entries, id, onChange) {
  return html`<label for=${id}
    >${title}<select id=${id} aria-label=${title} @change=${onChange}>
      ${entries.map(([value, text]) => html`<option value=${value}>${text}</option>`)}
    </select></label
  >`;
}
function filterSelect(title, entries) {
  const label = nodeOf(filterSelectTemplate(title, entries, filterControlID(title)));
  const select = label.querySelector('select');
  select.value = 'all';
  return { label, select };
}
function filterSearchTemplate(
  title,
  id,
  { value = '', placeholder = '', maxLength = 120 },
  onInput,
) {
  return html`<label for=${id}
    >${title}<input
      id=${id}
      type="search"
      autocomplete="off"
      .value=${live(value)}
      placeholder=${placeholder}
      maxlength=${maxLength}
      aria-label=${title}
      @input=${onInput}
  /></label>`;
}
function filterSearch(title, { value = '', placeholder = '', maxLength = 120 } = {}) {
  const input = noAutofill(el('input'));
  input.id = filterControlID(title);
  input.type = 'search';
  input.value = value;
  input.placeholder = placeholder;
  input.maxLength = maxLength;
  input.setAttribute('aria-label', title);
  const label = el('label', title);
  label.setAttribute('for', input.id);
  label.append(input);
  return { label, input };
}
function controlSlug(title) {
  return (
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'control'
  );
}
// Removable chips are the authoritative view of a multi-value filter group.
function filterChipRowTemplate(ariaLabel, chips) {
  return html`<div class="filter-chips" role="group" aria-label=${ariaLabel} ?hidden=${!chips.length}>
    ${chips}
  </div>`;
}
function filterChipRow(ariaLabel) {
  return nodeOf(filterChipRowTemplate(ariaLabel, []));
}
// Filter bars live in a slot so the shared planning bar can be relocated
// between hosts rather than duplicated. A slot that receives the relocated bar
// must have no bound children, so lit never touches the moved node.
function filterSlotTemplate(id, ...children) {
  return html`<div class="filter-slot" id=${id || nothing}>${children.filter(Boolean)}</div>`;
}
function filterSlot(id, ...children) {
  const slot = el('div', undefined, 'filter-slot');
  if (id) slot.id = id;
  slot.append(...children.filter(Boolean));
  return slot;
}

function maintenanceListTemplate(className, rows) {
  return html`<div class=${className ? `maintenance-list ${className}` : 'maintenance-list'}>
    ${rows}
  </div>`;
}
function maintenanceList(className) {
  return el('div', undefined, className ? `maintenance-list ${className}` : 'maintenance-list');
}
// One row shape for Projects, Members and Labels: identity on the left,
// optional actions on the right.
function maintenanceRowTemplate({ tag = 'div', className = '', content = [], actions = [] } = {}) {
  const classes = `setup-row maintenance-row${className ? ` ${className}` : ''}`;
  const visible = actions.filter(Boolean);
  const body = html`<div class="maintenance-row-info">${content.filter(Boolean)}</div>
    ${visible.length ? html`<div class="actions">${visible}</div>` : nothing}`;
  return tag === 'article'
    ? html`<article class=${classes}>${body}</article>`
    : html`<div class=${classes}>${body}</div>`;
}
function maintenanceRow(options) {
  return nodeOf(maintenanceRowTemplate(options));
}

export {
  contentRoot,
  renderRoot,
  pageStack,
  renderPage,
  panel,
  panelTemplate,
  sectionHead,
  sectionHeadTemplate,
  panelHead,
  panelHeadTemplate,
  helpText,
  helpTextTemplate,
  statusLine,
  statusLineTemplate,
  setStatusText,
  errorLine,
  errorLineTemplate,
  setErrorText,
  emptyState,
  emptyStateTemplate,
  metricList,
  metricListTemplate,
  filterBar,
  filterBarTemplate,
  filterControlID,
  filterSelect,
  filterSelectTemplate,
  filterSearch,
  filterSearchTemplate,
  filterChipRow,
  filterChipRowTemplate,
  filterSlot,
  filterSlotTemplate,
  maintenanceList,
  maintenanceListTemplate,
  maintenanceRow,
  maintenanceRowTemplate,
};
