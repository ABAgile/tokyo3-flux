// Multi-select fields, the label color picker and help popovers.
import { el, uid } from './dom.js';
import { requestKey } from './api.js';
import { attach, html, live, nodeOf, nothing, render, repeat, styleProps } from './lit.js';

const LABEL_PALETTE = Object.freeze([
  '#ff6b6b',
  '#f94144',
  '#e63946',
  '#d62828',
  '#c1121f',
  '#a4161a',
  '#8d0801',
  '#6a040f',
  '#ff9f1c',
  '#ff8500',
  '#f77f00',
  '#e76f00',
  '#d95d00',
  '#c75100',
  '#aa4a00',
  '#833800',
  '#ffe066',
  '#ffd166',
  '#ffcc00',
  '#fcbf49',
  '#f9c74f',
  '#e9c46a',
  '#d4a72c',
  '#8f6d00',
  '#dcefe4',
  '#90be6d',
  '#70ad47',
  '#52b788',
  '#40916c',
  '#2d6a4f',
  '#237a57',
  '#14532d',
  '#2ec4b6',
  '#20a39e',
  '#00a896',
  '#0a9396',
  '#087f8f',
  '#147d92',
  '#145a42',
  '#0b525b',
  '#4dabf7',
  '#339af0',
  '#228be6',
  '#1971c2',
  '#1864ab',
  '#155e75',
  '#0d4f8b',
  '#0b3d91',
  '#748ffc',
  '#5c7cfa',
  '#4c6ef5',
  '#4263eb',
  '#364fc7',
  '#3f37c9',
  '#3730a3',
  '#2b2d6e',
  '#c77dff',
  '#b26fff',
  '#9d4edd',
  '#8338ec',
  '#7209b7',
  '#6a0dad',
  '#5a189a',
  '#3c096c',
]);
// A help popover is a small stateful widget: a trigger toggles a tooltip that
// closes on Escape or an outside click. Its text is fixed per instance, so a
// template that shows changing text should wrap it in keyed(text, ...).
function mountHelpPopover(wrapper, text, name) {
  const contentID = `help-${requestKey()}`;
  let open = false;
  let outside;
  const update = () =>
    render(
      html`<button
          type="button"
          class="help-trigger"
          aria-label=${`Help: ${name}`}
          aria-expanded=${String(open)}
          aria-controls=${contentID}
          aria-describedby=${contentID}
          @click=${toggle}
          @keydown=${(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }}
        >?</button
        ><span class="help-popover-content" id=${contentID} ?hidden=${!open} role="tooltip"
          >${text}</span
        >`,
      wrapper,
    );
  function close(focus = false) {
    if (!open) return;
    open = false;
    document.removeEventListener('click', outside);
    update();
    if (focus) wrapper.querySelector('.help-trigger').focus();
  }
  function toggle() {
    if (open) {
      close(true);
      return;
    }
    open = true;
    outside = (event) => {
      if (!wrapper.contains(event.target)) close();
    };
    document.addEventListener('click', outside);
    update();
  }
  update();
}
export function helpPopoverTemplate(text, name = 'Help') {
  return html`<span class="help-popover" ${attach(mountHelpPopover, text, name)}></span>`;
}
export function helpPopover(text, name = 'Help') {
  return nodeOf(helpPopoverTemplate(text, name));
}
function uniqueEntries(entries) {
  const seen = new Set();
  return entries
    .map(([value, text]) => [String(value), String(text)])
    .filter(([value]) => !seen.has(value) && seen.add(value));
}
// A multi-select is a stateful widget: it renders itself with lit into its
// group element from a local state object, and the checkboxes it renders carry
// the form values. `decorate(chip, value, text)` runs once per chip, when lit
// creates it. The returned controls let callers replace entries, report a
// status, select a value or read the selection. `settings.headingAction`
// returns an optional template shown after the heading ("Assign me"), and
// `settings.footer` one shown below the options; `controls.update()` re-renders
// both.
export function multiSelect(parent, ...options) {
  const group = el('div', undefined, 'multi-select-field');
  parent.append(group);
  return mountMultiSelect(group, ...options);
}
// Template form: `settings.onReady(controls)` receives the controls once the
// widget has rendered.
export function multiSelectTemplate(name, title, entries, selected, decorate, helpText, settings) {
  return html`<div
    class="multi-select-field"
    ${attach((group) => {
      const controls = mountMultiSelect(
        group,
        name,
        title,
        entries,
        selected,
        decorate,
        helpText,
        settings,
      );
      settings?.onReady?.(controls);
    })}
  ></div>`;
}
function mountMultiSelect(
  group,
  name,
  title,
  entries,
  selected = [],
  decorate,
  helpText,
  settings = {},
) {
  const {
    single = false,
    emptyValue,
    onChange,
    onFilter,
    onOpen,
    headingAction,
    footer,
  } = settings;
  const menuID = `multi-select-${requestKey()}`;
  const filterID = uid('multi-select-filter');
  const local = { entries: [], selected: new Set(), editing: false, query: '', status: '' };
  const help = helpText ? helpPopoverTemplate(helpText, title) : nothing;
  let controls, outside;
  const currentValues = () =>
    local.entries.filter(([value]) => local.selected.has(value)).map(([value]) => value);
  const changed = (notifyForm) => {
    update();
    if (onChange) onChange(currentValues());
    if (notifyForm) controls.root.dispatchEvent(new Event('change', { bubbles: true }));
  };
  function replaceEntries(nextEntries, selectedValues = []) {
    let values = selectedValues.map(String);
    if (single && values.length > 1) values = [values[0]];
    local.entries = uniqueEntries(nextEntries);
    local.selected = new Set(values.filter((value) => local.entries.some(([v]) => v === value)));
    update();
  }
  function toggleValue(value, checked) {
    if (checked) {
      if (single) local.selected.clear();
      if (emptyValue !== undefined)
        for (const other of [...local.selected])
          if (value === String(emptyValue) || other === String(emptyValue))
            local.selected.delete(other);
      local.selected.add(value);
    } else local.selected.delete(value);
    changed(false);
  }
  function selectValue(value) {
    if (!single || !local.entries.some(([v]) => v === String(value))) return false;
    local.selected = new Set([String(value)]);
    changed(true);
    return true;
  }
  function setStatus(text) {
    local.status = text || '';
    update();
  }
  function invoke(handler, query) {
    if (!handler) return;
    try {
      Promise.resolve(handler(query, controls)).catch((error) =>
        setStatus(error.message || String(error)),
      );
    } catch (error) {
      setStatus(error.message || String(error));
    }
  }
  function close(focus = false) {
    if (!local.editing) return;
    local.editing = false;
    document.removeEventListener('click', outside);
    update();
    if (focus) controls.edit.focus();
  }
  function open() {
    local.editing = true;
    outside = (event) => {
      if (!group.contains(event.target)) close();
    };
    document.addEventListener('click', outside);
    update();
    controls.filter.focus();
    controls.filter.select();
    invoke(onOpen, controls.filter.value.trim());
  }
  const toggle = () => (local.editing ? close(true) : open());
  const closeOnEscape = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };
  const decorateChip = (chip, value, text) => decorate?.(chip, value, text);
  function update() {
    const { editing, query, status } = local;
    const needle = query.toLowerCase();
    const chosen = local.entries.filter(([value]) => local.selected.has(value));
    const visible = local.entries.filter(
      ([, text]) => !needle || text.toLowerCase().includes(needle),
    );
    render(
      html`<div
          class="multi-select-header"
          @click=${(event) => {
            if (local.editing && !controls.edit.contains(event.target)) close();
          }}
        >
          <span class="multi-select-heading"
            ><span class="multi-select-label">${title}</span>${help}${headingAction?.() ?? nothing}</span
          >
          <button
            type="button"
            class="multi-select-edit"
            data-multi-edit="true"
            aria-label=${`Edit ${title}`}
            aria-haspopup="true"
            aria-expanded=${String(editing)}
            aria-controls=${menuID}
            @click=${toggle}
          >Edit</button>
        </div>
        <div class="multi-select" role="group" aria-label=${title}>
          <div class="multi-select-values">
            ${chosen.length ? nothing : html`<span class="multi-select-empty">None selected</span>`}
            ${repeat(
              chosen,
              ([value]) => value,
              ([value, text]) => html`<span
                class="multi-select-chip"
                ${attach(decorateChip, value, text)}
                ><span>${text}</span
                ><button
                  type="button"
                  class="multi-select-remove"
                  data-multi-remove="true"
                  ?hidden=${!editing}
                  aria-label=${`Remove ${text}`}
                  @click=${() => {
                    local.selected.delete(value);
                    changed(true);
                  }}
                >×</button></span
              >`,
            )}
          </div>
          <div
            class="multi-select-menu"
            ?hidden=${!editing}
            id=${menuID}
            role="group"
            aria-label=${`${title} options`}
            @keydown=${closeOnEscape}
          >
            <input
              id=${filterID}
              type="search"
              class="multi-select-filter"
              placeholder=${`Filter ${title.toLowerCase()}…`}
              aria-label=${`Filter ${title}`}
              autocomplete="off"
              @input=${(event) => {
                local.query = event.currentTarget.value.trim();
                update();
                invoke(onFilter, local.query);
              }}
            />
            <p
              class="multi-select-empty"
              data-status-class="multi-select-empty"
              ?hidden=${!status}
              role="status"
              aria-live="polite"
            >${status}</p>
            <div class="multi-select-options">
              ${repeat(
                local.entries,
                ([value]) => value,
                ([value, text]) => html`<label
                  class="multi-select-option"
                  ?hidden=${!visible.some(([v]) => v === value)}
                  ><input
                    type="checkbox"
                    name=${name}
                    value=${value}
                    .checked=${live(local.selected.has(value))}
                    aria-label=${text}
                    @change=${(event) => toggleValue(value, event.currentTarget.checked)}
                  /><span>${text}</span></label
                >`,
              )}
            </div>
            <p class="multi-select-empty" ?hidden=${visible.length > 0 || !!status}>No matches.</p>
          </div>
        </div>
        ${footer?.() ?? nothing}`,
      group,
    );
  }
  replaceEntries(entries, selected);
  const header = group.querySelector('.multi-select-header');
  controls = {
    root: group.querySelector('.multi-select'),
    group,
    header,
    edit: header.querySelector('[data-multi-edit]'),
    filter: group.querySelector('.multi-select-filter'),
    close,
    isOpen: () => local.editing,
    setEntries: (nextEntries, selectedValues) =>
      replaceEntries(nextEntries, selectedValues === undefined ? currentValues() : selectedValues),
    setStatus,
    select: selectValue,
    selected: currentValues,
    update,
  };
  return controls;
}
export function labelColorPickerTemplate(value) {
  const selected = String(value || '')
    .trim()
    .toLowerCase();
  return html`<fieldset class="label-palette">
    <legend>Label color</legend>
    ${LABEL_PALETTE.map(
      (color) => html`<input
        type="radio"
        name="color"
        value=${color}
        .checked=${color === selected}
        aria-label=${color}
        title=${color}
        ${styleProps({ 'background-color': color })}
      />`,
    )}
  </fieldset>`;
}
export function labelColorPicker(parent, value) {
  const palette = nodeOf(labelColorPickerTemplate(value));
  parent.append(palette);
  return palette;
}
