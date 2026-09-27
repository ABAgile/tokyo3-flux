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
// Every component is a Preact template (`*Template`); emptyState also has a node
// form for the loading page, which is appended to a static host.
import { el, uid } from './dom.js';
import { html, nodeOf, nothing, render, replaceContent } from './preact.js';

// #content holds exactly one page root. `data-content-view` names the
// composition, so the next render updates the same root while the page kind is
// unchanged.
function contentRoot(tag, className, contentView) {
  const root = el(tag, undefined, className);
  if (contentView) root.dataset.contentView = contentView;
  return root;
}
// Renders a view's template into its page root. The root persists while the
// host shows the same view, so Preact updates it in place; a new root is filled
// while detached and then replaces the host's content in one insertion.
function renderRoot(host, className, contentView, template, tag = 'div') {
  const current = host.firstElementChild;
  const root =
    current?.dataset.contentView === contentView
      ? current
      : contentRoot(tag, className, contentView);
  render(template, root);
  if (root !== current) replaceContent(host, root);
  return root;
}
// A bordered surface. Variants add their own padding and inner layout.
function panelTemplate(className, content, tag = 'section') {
  const classes = className ? `panel ${className}` : 'panel';
  return tag === 'article'
    ? html`<article class=${classes}>${content}</article>`
    : html`<section class=${classes}>${content}</section>`;
}
// Page-level section title with optional right-aligned actions.
function sectionHeadTemplate(title, ...actions) {
  return html`<div class="section-head"><h2>${title}</h2>${actions.filter(Boolean)}</div>`;
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
// Guidance text. `variant` adds a page-specific class beside the shared one.
function helpTextTemplate(text, variant) {
  return html`<p class=${variant ? `help ${variant}` : 'help'}>${text}</p>`;
}
// Status lines are inline live regions: polite while they report progress,
// assertive while they carry an error, hidden while they say nothing. Widgets
// render them from their own state. setStatusText and setErrorText write the
// status and error lines of rendered-once DOM (the detail form, the workspace
// creation form, the integration form).
// Error lines are one-line regions, empty and hidden until a write fails.
// Errors never share a node with progress, so they are announced once and stay
// until the next attempt clears them.
function errorLineTemplate(text = '', className = 'error') {
  return html`<p class=${className} role="alert" hidden=${!text}>${text}</p>`;
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
// Empty states are marked with data-empty.
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

// The only filter container: labeled native controls on the left, a
// right-aligned visible record count.
function filterBarTemplate(controls, count = '') {
  return html`<div class="filter-bar">
    <div class="actions">${controls}</div>
    <span class="filter-bar-count muted" aria-live="polite">${count}</span>
  </div>`;
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
    >${title}<select id=${id} aria-label=${title} onChange=${onChange}>
      ${entries.map(([value, text]) => html`<option value=${value}>${text}</option>`)}
    </select></label
  >`;
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
      value=${value}
      placeholder=${placeholder}
      maxlength=${maxLength}
      aria-label=${title}
      onInput=${onInput}
  /></label>`;
}
// A labeled form control. `options` carries its attributes. Values are bound
// once per mount: forms are rendered when opened and then belong to the user.
function fieldTemplate(name, title, value = '', type = 'text', entries, options = {}) {
  const {
    className,
    controlFirst = false,
    id,
    required = false,
    readOnly = false,
    disabled = false,
    maxLength,
    placeholder,
    min,
    max,
    step,
    autocomplete,
    onChange,
    onInput,
  } = options;
  const text = typeof value === 'string' ? value : String(value ?? '');
  const choice = type === 'checkbox' || type === 'radio' || type === 'file';
  const control = entries
    ? html`<select
        name=${name}
        id=${id || nothing}
        required=${required}
        disabled=${disabled}
        onChange=${onChange}
      >
        ${entries.map(
          ([optionValue, optionText]) =>
            html`<option value=${optionValue} selected=${String(optionValue) === text}
              >${optionText}</option
            >`,
        )}
      </select>`
    : type === 'textarea'
      ? html`<textarea
          name=${name}
          id=${id || nothing}
          autocomplete=${autocomplete || 'off'}
          required=${required}
          readonly=${readOnly}
          disabled=${disabled}
          aria-readonly=${readOnly ? 'true' : nothing}
          maxlength=${maxLength ?? nothing}
          placeholder=${placeholder ?? nothing}
          defaultValue=${text}
          onInput=${onInput}
          onChange=${onChange}
        ></textarea>`
      : html`<input
          name=${name}
          type=${type}
          id=${id || nothing}
          autocomplete=${choice ? nothing : autocomplete || 'off'}
          required=${required}
          readonly=${readOnly}
          disabled=${disabled}
          aria-readonly=${readOnly ? 'true' : nothing}
          maxlength=${maxLength ?? nothing}
          placeholder=${placeholder ?? nothing}
          min=${min ?? nothing}
          max=${max ?? nothing}
          step=${step ?? nothing}
          defaultValue=${text}
          onInput=${onInput}
          onChange=${onChange}
        />`;
  return controlFirst
    ? html`<label class=${className || nothing}>${control}${title}</label>`
    : html`<label class=${className || nothing}>${title}${control}</label>`;
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
  return html`<div class="filter-chips" role="group" aria-label=${ariaLabel} hidden=${!chips.length}>
    ${chips}
  </div>`;
}
// Filter bars live in a slot so the shared planning bar can be relocated
// between hosts rather than duplicated. A slot that receives the relocated bar
// must have no bound children, so Preact never touches the moved node.
function filterSlotTemplate(id, ...children) {
  return html`<div class="filter-slot" id=${id || nothing}>${children.filter(Boolean)}</div>`;
}

function maintenanceListTemplate(className, rows) {
  return html`<div class=${className ? `maintenance-list ${className}` : 'maintenance-list'}>
    ${rows}
  </div>`;
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

export {
  contentRoot,
  renderRoot,
  panelTemplate,
  sectionHeadTemplate,
  panelHeadTemplate,
  helpTextTemplate,
  setStatusText,
  errorLineTemplate,
  setErrorText,
  emptyState,
  emptyStateTemplate,
  metricListTemplate,
  filterBarTemplate,
  filterControlID,
  filterSelectTemplate,
  filterSearchTemplate,
  fieldTemplate,
  filterChipRowTemplate,
  filterSlotTemplate,
  maintenanceListTemplate,
  maintenanceRowTemplate,
};
