// Multi-select fields, the label color picker and help popovers.
import { uid } from './dom.js';
import { requestKey } from './api.js';
import {
  attach,
  html,
  nodeOf,
  nothing,
  keyedList,
  useLayoutEffect,
  useRef,
  useState,
} from './preact.js';

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
function HelpPopover({ text, name }) {
  const [contentID] = useState(() => `help-${requestKey()}`);
  const [open, setOpen] = useState(false);
  const wrapper = useRef();
  const trigger = useRef();
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!wrapper.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('click', outside);
    return () => document.removeEventListener('click', outside);
  }, [open]);
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
      onKeydown=${(event) => {
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
export function helpPopoverTemplate(text, name = 'Help') {
  return html`<${HelpPopover} text=${text} name=${name} />`;
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
// This component owns picker state and exposes a stable control facade to
// remote-option loaders. `onReady` receives it once; callers can replace entries,
// set status, select a value and inspect the current selection without rendering
// or owning the picker's subtree. `headingAction` and `footer` return VNodes.
export function multiSelectTemplate(name, title, entries, selected, decorate, helpText, settings) {
  return html`<${MultiSelect}
      name=${name}
      title=${title}
      entries=${entries}
      selected=${selected}
      decorate=${decorate}
      helpText=${helpText}
      settings=${settings}
    />`;
}
function MultiSelect({ name, title, entries, selected = [], decorate, helpText, settings = {} }) {
  const [menuID] = useState(() => `multi-select-${requestKey()}`);
  const [filterID] = useState(() => uid('multi-select-filter'));
  const [local, setLocal] = useState(() => {
    const initialEntries = uniqueEntries(entries);
    let initialSelected = selected.map(String);
    if (settings.single && initialSelected.length > 1) initialSelected = [initialSelected[0]];
    return {
      entries: initialEntries,
      selected: new Set(
        initialSelected.filter((value) => initialEntries.some(([entry]) => entry === value)),
      ),
      editing: false,
      status: '',
      query: '',
    };
  });
  // Keep the latest state readable by stable callbacks before Preact commits.
  const localRef = useRef(local);
  localRef.current = local;
  const group = useRef();
  const header = useRef();
  const root = useRef();
  const edit = useRef();
  const filter = useRef();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const actions = useRef({});
  const controls = useRef();
  if (!controls.current) {
    controls.current = {
      get root() {
        return root.current;
      },
      get group() {
        return group.current;
      },
      get header() {
        return header.current;
      },
      get edit() {
        return edit.current;
      },
      get filter() {
        return filter.current;
      },
      close: (...args) => actions.current.close(...args),
      isOpen: () => localRef.current.editing,
      dispose: () => actions.current.close(false),
      setEntries: (...args) => actions.current.setEntries(...args),
      setStatus: (...args) => actions.current.setStatus(...args),
      select: (...args) => actions.current.select(...args),
      selected: () => actions.current.selected(),
      update: () => actions.current.update(),
    };
  }
  const updateLocal = (next) => {
    const value = typeof next === 'function' ? next(localRef.current) : next;
    localRef.current = value;
    setLocal(value);
  };
  const currentValues = () =>
    localRef.current.entries
      .filter(([value]) => localRef.current.selected.has(value))
      .map(([value]) => value);
  const setStatus = (text) => updateLocal({ ...localRef.current, status: text || '' });
  const replaceEntries = (nextEntries, selectedValues = currentValues()) => {
    const config = settingsRef.current;
    let values = selectedValues.map(String);
    if (config.single && values.length > 1) values = [values[0]];
    const next = uniqueEntries(nextEntries);
    updateLocal({
      ...localRef.current,
      entries: next,
      selected: new Set(values.filter((value) => next.some(([candidate]) => candidate === value))),
    });
  };
  const changed = (nextSelected, notifyForm = false) => {
    updateLocal({ ...localRef.current, selected: nextSelected });
    settingsRef.current.onChange?.(
      localRef.current.entries.filter(([value]) => nextSelected.has(value)).map(([value]) => value),
    );
    if (notifyForm) root.current?.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const toggleValue = (value, checked) => {
    const config = settingsRef.current;
    const next = new Set(localRef.current.selected);
    if (checked) {
      if (config.single) next.clear();
      if (config.emptyValue !== undefined)
        for (const other of [...next])
          if (value === String(config.emptyValue) || other === String(config.emptyValue))
            next.delete(other);
      next.add(value);
    } else next.delete(value);
    changed(next);
  };
  const selectValue = (value) => {
    const current = localRef.current;
    if (
      !settingsRef.current.single ||
      !current.entries.some(([candidate]) => candidate === String(value))
    )
      return false;
    changed(new Set([String(value)]), true);
    return true;
  };
  const invoke = (handler, query) => {
    if (!handler) return;
    try {
      Promise.resolve(handler(query, controls.current)).catch((error) =>
        setStatus(error.message || String(error)),
      );
    } catch (error) {
      setStatus(error.message || String(error));
    }
  };
  const close = (focus = false) => {
    if (!localRef.current.editing) return;
    updateLocal({ ...localRef.current, editing: false });
    if (focus) edit.current?.focus();
  };
  const open = () => updateLocal({ ...localRef.current, editing: true });
  const toggle = () => (localRef.current.editing ? close(true) : open());
  const actionsRef = actions;
  actionsRef.current = {
    close,
    setEntries: (nextEntries, selectedValues) =>
      replaceEntries(nextEntries, selectedValues === undefined ? currentValues() : selectedValues),
    setStatus,
    select: selectValue,
    selected: currentValues,
    update: () => updateLocal({ ...localRef.current }),
  };
  useLayoutEffect(() => {
    if (!local.editing) return;
    const outside = (event) => {
      if (!group.current?.contains(event.target)) actions.current.close(false);
    };
    document.addEventListener('click', outside);
    return () => document.removeEventListener('click', outside);
  }, [local.editing]);
  const wasEditing = useRef(false);
  useLayoutEffect(() => {
    if (!wasEditing.current && local.editing) {
      filter.current?.focus();
      filter.current?.select();
      invoke(settingsRef.current.onOpen, filter.current?.value.trim() || '');
    }
    wasEditing.current = local.editing;
  }, [local.editing]);
  useLayoutEffect(() => {
    settingsRef.current.onReady?.(controls.current);
  }, []);
  const { editing, status, query } = local;
  const needle = query.toLowerCase();
  const chosen = local.entries.filter(([value]) => local.selected.has(value));
  const visible = local.entries.filter(
    ([, text]) => !needle || text.toLowerCase().includes(needle),
  );
  const help = helpText ? helpPopoverTemplate(helpText, title) : nothing;
  const closeOnEscape = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };
  const decorateChip = (chip, value, text) => decorate?.(chip, value, text);
  return html`<div class="multi-select-field" ref=${group}>
    <div class="multi-select-header" ref=${header}
      onClick=${(event) => {
        if (localRef.current.editing && !edit.current?.contains(event.target)) close();
      }}
    >
      <span class="multi-select-heading"
        ><span class="multi-select-label">${title}</span>${help}${settings.headingAction?.() ?? nothing}</span
      >
      <button
        type="button"
        class="multi-select-edit"
        data-multi-edit="true"
        aria-label=${`Edit ${title}`}
        aria-haspopup="true"
        aria-expanded=${String(editing)}
        aria-controls=${menuID}
        disabled=${!!settings.disabled}
        ref=${edit}
        onClick=${toggle}
      >Edit</button>
    </div>
    <div class="multi-select" role="group" aria-label=${title} ref=${root}>
      <div class="multi-select-values">
        ${chosen.length ? nothing : html`<span class="multi-select-empty">None selected</span>`}
        ${keyedList(
          chosen,
          ([value]) => value,
          ([value, text]) => html`<span
            class="multi-select-chip"
            ref=${attach(decorateChip, value, text)}
            ><span>${text}</span
            ><button
              type="button"
              class="multi-select-remove"
              data-multi-remove="true"
              hidden=${!editing}
              disabled=${!!settings.disabled}
              aria-label=${`Remove ${text}`}
              onClick=${() => {
                const next = new Set(localRef.current.selected);
                next.delete(value);
                changed(next, true);
              }}
            >×</button></span
          >`,
        )}
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
          disabled=${!!settings.disabled}
          value=${query}
          ref=${filter}
          onInput=${(event) => {
            const nextQuery = event.currentTarget.value;
            updateLocal({ ...localRef.current, query: nextQuery });
            invoke(settingsRef.current.onFilter, nextQuery.trim());
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
          ${keyedList(
            local.entries,
            ([value]) => value,
            ([value, text]) => html`<label
              class="multi-select-option"
              hidden=${!visible.some(([candidate]) => candidate === value)}
              ><input
                type="checkbox"
                name=${name}
                value=${value}
                checked=${local.selected.has(value)}
                disabled=${!!settings.disabled}
                aria-label=${text}
                onChange=${(event) => toggleValue(value, event.currentTarget.checked)}
              /><span>${text}</span></label
            >`,
          )}
        </div>
        <p class="multi-select-empty" hidden=${visible.length > 0 || !!status}>No matches.</p>
      </div>
    </div>
    ${settings.footer?.() ?? nothing}
  </div>`;
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
        checked=${color === selected}
        aria-label=${color}
        title=${color}
        style=${{ 'background-color': color }}
      />`,
    )}
  </fieldset>`;
}
