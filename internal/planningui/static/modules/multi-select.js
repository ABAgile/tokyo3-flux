// Multi-select fields, the label color picker and help popovers.
import { html } from './vdom.js';
import { useId, useLayoutEffect, useReducer, useRef, useState } from './vendor-preact.js';
import { useCommittedChange, useDismiss } from './ui-hooks.js';

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
// A help popover toggles its tooltip and closes on Escape or an outside click.
/** @param {{ text: unknown, name: string }} props */
function HelpPopover({ text, name }) {
  const contentID = `help-${useId()}`;
  const [open, setOpen] = useState(false);
  const wrapper = useRef(/** @type {HTMLElement | null} */ (null));
  const trigger = useRef(/** @type {HTMLButtonElement | null} */ (null));
  useDismiss(wrapper, open, () => setOpen(false), { closeOnEscape: false, event: 'click' });
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return html`<span class="help-popover" ref=${wrapper}
    ><button
      type="button"
      class="help-trigger"
      aria-label=${`Help: ${name}`}
      aria-expanded=${String(open)}
      aria-controls=${contentID}
      aria-describedby=${contentID}
      ref=${trigger}
      onClick=${() => setOpen((previous) => !previous)}
      onKeydown=${(/** @type {KeyboardEvent} */ event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >?</button
    ><span class="help-popover-content" id=${contentID} hidden=${!open} role="tooltip">${text}</span
    ></span
  >`;
}
/**
 * @param {unknown} text
 * @param {string} [name]
 */
export function helpPopoverTemplate(text, name = 'Help') {
  return html`<${HelpPopover} text=${text} name=${name} />`;
}
/**
 * @param {readonly (readonly Flux.SelectValue[])[]} entries
 * @returns {[string, string][]}
 */
function uniqueEntries(entries) {
  /** @type {Set<string>} */
  const seen = new Set();
  return entries
    .map(([value, text]) => /** @type {[string, string]} */ ([String(value), String(text)]))
    .filter(([value]) => !seen.has(value) && seen.add(value));
}
/**
 * @param {readonly Flux.SelectValue[] | undefined} values
 * @param {boolean} single
 */
function initialSelection(values, single) {
  const list = (values || []).map(String);
  return single && list.length > 1 ? [list[0]] : list;
}
/** @typedef {{ selected: string[], editing: boolean, query: string }} PickerState */
/**
 * @typedef {{ type: 'open' | 'close' }
 *   | { type: 'query', query: string }
 *   | { type: 'select', selected: string[] }} PickerAction
 */
/**
 * @param {PickerState} current
 * @param {PickerAction} action
 * @returns {PickerState}
 */
function pickerReducer(current, action) {
  switch (action.type) {
    case 'open':
      return current.editing ? current : { ...current, editing: true };
    case 'close':
      return current.editing ? { ...current, editing: false } : current;
    case 'query':
      return { ...current, query: action.query };
    case 'select':
      return { ...current, selected: action.selected };
    default:
      return current;
  }
}
// A labelled chip picker whose checkboxes submit with the enclosing form.
// A checkbox commits on `input`, not `change`: a form-level `input` listener may
// re-render between the two events, and the controlled `checked` would then
// reset the box before `change` reports it.
//
// Uncontrolled pickers take `defaultValue` and report committed selections
// through `onChange(values)`; controlled pickers take `value` and report the
// requested selection. Remote pickers own their `entries` and `status`, and
// hear the typed filter through `onQuery(query)` and the menu state through
// `onOpenChange(open, query)`. `headingAction({ select })` renders beside the
// title; `footer` renders below the picker.
/** @param {Flux.MultiSelectProps} props */
export function MultiSelect({
  name,
  title,
  entries,
  value,
  defaultValue = [],
  onChange,
  onQuery,
  onOpenChange,
  status = '',
  single = false,
  emptyValue,
  disabled = false,
  decorate,
  helpText,
  headingAction,
  footer = null,
  filterMaxLength,
}) {
  const id = useId();
  const menuID = `multi-select-${id}`;
  const filterID = `multi-select-filter-${id}`;
  const list = uniqueEntries(entries || []);
  const controlled = value !== undefined;
  const [local, dispatch] = useReducer(pickerReducer, undefined, () => ({
    selected: initialSelection(defaultValue, single).filter((candidate) =>
      list.some(([entry]) => entry === candidate),
    ),
    editing: false,
    query: '',
  }));
  const selected = controlled ? initialSelection(value, single) : local.selected;
  const group = useRef(/** @type {HTMLDivElement | null} */ (null));
  const edit = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const filter = useRef(/** @type {HTMLInputElement | null} */ (null));
  const { editing, query } = local;
  const chosenValues = list.filter(([entry]) => selected.includes(entry)).map(([entry]) => entry);
  const setSelected = (/** @type {string[]} */ next) => {
    if (controlled) onChange?.(list.filter(([entry]) => next.includes(entry)).map(([v]) => v));
    else dispatch({ type: 'select', selected: next });
  };
  // Uncontrolled selections are reported once rendered, so form readers see them.
  useCommittedChange(controlled ? undefined : local.selected, () => {
    if (!controlled) onChange?.(chosenValues);
  });
  const toggleValue = (/** @type {string} */ candidate, /** @type {boolean} */ checked) => {
    let next = selected.filter((current) => current !== candidate);
    if (checked) {
      if (single) next = [];
      if (emptyValue !== undefined)
        next = next.filter(
          (other) => candidate !== String(emptyValue) && other !== String(emptyValue),
        );
      next = [...next, candidate];
    }
    setSelected(next);
  };
  const select = (/** @type {Flux.SelectValue} */ candidate) => {
    const next = String(candidate);
    if (!single || !list.some(([entry]) => entry === next)) return false;
    setSelected([next]);
    return true;
  };
  const close = (focus = false) => {
    if (!editing) return;
    dispatch({ type: 'close' });
    onOpenChange?.(false, query.trim());
    if (focus) edit.current?.focus();
  };
  const open = () => dispatch({ type: 'open' });
  useDismiss(group, editing, () => close(false), { closeOnEscape: false, event: 'click' });
  const wasEditing = useRef(false);
  useLayoutEffect(() => {
    if (!wasEditing.current && editing) {
      filter.current?.focus();
      filter.current?.select();
      onOpenChange?.(true, query.trim());
    }
    wasEditing.current = editing;
  }, [editing]);
  const needle = query.toLowerCase();
  const chosen = list.filter(([entry]) => selected.includes(entry));
  const visible = new Set(
    list.filter(([, text]) => !needle || text.toLowerCase().includes(needle)).map(([v]) => v),
  );
  const help = helpText ? helpPopoverTemplate(helpText, title) : null;
  const closeOnEscape = (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };
  return html`<div class="multi-select-field" ref=${group}>
    <div class="multi-select-header"
      onClick=${(/** @type {MouseEvent} */ event) => {
        if (editing && !edit.current?.contains(/** @type {Node | null} */ (event.target))) close();
      }}
    >
      <span class="multi-select-heading"
        ><span class="multi-select-label">${title}</span>${help}${headingAction?.({ select }) ?? null}</span
      >
      <button
        type="button"
        class="multi-select-edit"
        data-multi-edit="true"
        aria-label=${`Edit ${title}`}
        aria-haspopup="true"
        aria-expanded=${String(editing)}
        aria-controls=${menuID}
        disabled=${!!disabled}
        ref=${edit}
        onClick=${() => (editing ? close(true) : open())}
      >Edit</button>
    </div>
    <div class="multi-select" role="group" aria-label=${title}>
      <div class="multi-select-values">
        ${chosen.length ? null : html`<span class="multi-select-empty">None selected</span>`}
        ${chosen.map(([entry, text]) => {
          const decoration = decorate?.(entry, text);
          return html`<span
            key=${entry}
            class=${`multi-select-chip${decoration?.className ? ` ${decoration.className}` : ''}`}
            style=${decoration?.style}
            ><span>${text}</span
            ><button
              type="button"
              class="multi-select-remove"
              data-multi-remove="true"
              hidden=${!editing}
              disabled=${!!disabled}
              aria-label=${`Remove ${text}`}
              onClick=${() => setSelected(selected.filter((current) => current !== entry))}
            >×</button></span
          >`;
        })}
      </div>
      <div
        class="multi-select-menu"
        hidden=${!editing}
        id=${menuID}
        role="group"
        aria-label=${`${title} options`}
        onKeydown=${closeOnEscape}
      >
        <input
          id=${filterID}
          type="search"
          class="multi-select-filter"
          placeholder=${`Filter ${title.toLowerCase()}…`}
          aria-label=${`Filter ${title}`}
          autocomplete="off"
          maxlength=${filterMaxLength ?? null}
          disabled=${!!disabled}
          value=${query}
          ref=${filter}
          onInput=${(/** @type {Flux.TargetEvent<HTMLInputElement>} */ event) => {
            const nextQuery = event.currentTarget.value;
            dispatch({ type: 'query', query: nextQuery });
            onQuery?.(nextQuery.trim());
          }}
        />
        <p
          class="multi-select-empty"
          data-status-class="multi-select-empty"
          hidden=${!status}
          role="status"
          aria-live="polite"
        >${status}</p>
        <div class="multi-select-options">
          ${list.map(
            ([entry, text]) => html`<label
              key=${entry}
              class="multi-select-option"
              hidden=${!visible.has(entry)}
              ><input
                type="checkbox"
                name=${name}
                value=${entry}
                checked=${selected.includes(entry)}
                disabled=${!!disabled}
                aria-label=${text}
                onInput=${(/** @type {Flux.TargetEvent<HTMLInputElement>} */ event) => toggleValue(entry, event.currentTarget.checked)}
              /><span>${text}</span></label
            >`,
          )}
        </div>
        <p class="multi-select-empty" hidden=${visible.size > 0 || !!status}>No matches.</p>
      </div>
    </div>
    ${footer}
  </div>`;
}
/** @param {unknown} value */
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
        checked=${color === selected}
        aria-label=${color}
        title=${color}
        style=${{ 'background-color': color }}
      />`,
    )}
  </fieldset>`;
}
