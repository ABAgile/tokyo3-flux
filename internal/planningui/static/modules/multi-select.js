// Multi-select fields, the label color picker and help popovers.
import { el, button, uid, noAutofill } from './dom.js';
import { requestKey } from './api.js';
import { statusLine, setStatusText } from './layout.js';

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
export function helpPopover(text, name = 'Help') {
  const wrapper = el('span', undefined, 'help-popover');
  const trigger = button('?', () => toggle(), 'help-trigger');
  const content = el('span', text, 'help-popover-content');
  content.id = `help-${requestKey()}`;
  content.hidden = true;
  content.setAttribute('role', 'tooltip');
  trigger.setAttribute('aria-label', `Help: ${name}`);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', content.id);
  trigger.setAttribute('aria-describedby', content.id);
  let outside;
  function close(focus = false) {
    if (content.hidden) return;
    content.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outside);
    if (focus) trigger.focus();
  }
  function open() {
    content.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    outside = (e) => {
      if (!wrapper.contains(e.target)) close();
    };
    document.addEventListener('click', outside);
  }
  function toggle() {
    if (content.hidden) open();
    else close(true);
  }
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  });
  wrapper.append(trigger, content);
  return wrapper;
}
export function multiSelect(
  parent,
  name,
  title,
  entries,
  selected = [],
  decorate,
  helpText,
  settings = {},
) {
  const single = settings.single === true;
  const emptyValue = settings.emptyValue;
  const onChange = settings.onChange;
  const onFilter = settings.onFilter;
  const onOpen = settings.onOpen;
  const group = el('div', undefined, 'multi-select-field');
  const label = el('span', title, 'multi-select-label');
  const heading = el('span', undefined, 'multi-select-heading');
  heading.append(label);
  if (helpText) heading.append(helpPopover(helpText, title));
  const root = el('div', undefined, 'multi-select');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', title);
  const values = el('div', undefined, 'multi-select-values');
  const menu = el('div', undefined, 'multi-select-menu');
  const filter = noAutofill(el('input'));
  filter.id = uid('multi-select-filter');
  filter.type = 'search';
  filter.className = 'multi-select-filter';
  filter.placeholder = `Filter ${title.toLowerCase()}…`;
  filter.setAttribute('aria-label', `Filter ${title}`);
  const list = el('div', undefined, 'multi-select-options');
  const status = statusLine('multi-select-empty');
  const empty = el('p', 'No matches.', 'multi-select-empty');
  menu.append(filter, status, list, empty);
  menu.hidden = true;
  menu.id = `multi-select-${requestKey()}`;
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', `${title} options`);
  const edit = button('Edit', toggle, 'multi-select-edit');
  edit.dataset.multiEdit = 'true';
  edit.setAttribute('aria-label', `Edit ${title}`);
  edit.setAttribute('aria-haspopup', 'true');
  edit.setAttribute('aria-expanded', 'false');
  edit.setAttribute('aria-controls', menu.id);
  const header = el('div', undefined, 'multi-select-header');
  header.append(heading, edit);
  header.addEventListener('click', (event) => {
    if (!menu.hidden && !edit.contains(event.target)) close();
  });
  let choices = [],
    controls,
    editing = false;
  function currentValues() {
    return choices.filter((choice) => choice.input.checked).map((choice) => choice.value);
  }
  function replaceEntries(nextEntries, selectedValues = []) {
    let selectedSet = new Set(selectedValues.map(String));
    if (single && selectedValues.length > 1) selectedSet = new Set([String(selectedValues[0])]);
    const seen = new Set();
    list.replaceChildren();
    choices = [];
    nextEntries.forEach(([rawValue, rawText]) => {
      const value = String(rawValue);
      if (seen.has(value)) return;
      seen.add(value);
      const text = String(rawText);
      const option = el('label', undefined, 'multi-select-option');
      const input = el('input');
      input.type = 'checkbox';
      input.name = name;
      input.value = value;
      input.checked = selectedSet.has(value);
      input.setAttribute('aria-label', text);
      option.append(input, el('span', text));
      list.append(option);
      const choice = { value, text, input, option };
      choices.push(choice);
      input.addEventListener('change', () => {
        if (single && input.checked)
          choices.forEach((other) => {
            if (other.input !== input) other.input.checked = false;
          });
        if (emptyValue !== undefined && input.checked)
          choices.forEach((other) => {
            if (
              other.input !== input &&
              (input.value === String(emptyValue) || other.value === String(emptyValue))
            )
              other.input.checked = false;
          });
        render();
        if (onChange) onChange(currentValues());
      });
    });
    render();
  }
  function setEntries(nextEntries, selectedValues) {
    replaceEntries(nextEntries, selectedValues === undefined ? currentValues() : selectedValues);
  }
  function selectValue(value) {
    if (!single) return false;
    const choice = choices.find((candidate) => candidate.value === String(value));
    if (!choice) return false;
    choices.forEach((candidate) => {
      candidate.input.checked = candidate === choice;
    });
    render();
    if (onChange) onChange(currentValues());
    root.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function setStatus(text) {
    setStatusText(status, text);
    render();
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
  let outside;
  function close(focus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    editing = false;
    edit.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outside);
    render();
    if (focus) edit.focus();
  }
  function open() {
    editing = true;
    menu.hidden = false;
    edit.setAttribute('aria-expanded', 'true');
    outside = (e) => {
      if (!group.contains(e.target)) close();
    };
    document.addEventListener('click', outside);
    render();
    filter.focus();
    filter.select();
    invoke(onOpen, filter.value.trim());
  }
  function toggle() {
    if (menu.hidden) open();
    else close(true);
  }
  function render() {
    values.replaceChildren();
    const chosen = choices.filter((choice) => choice.input.checked);
    if (!chosen.length) values.append(el('span', 'None selected', 'multi-select-empty'));
    chosen.forEach((choice) => {
      const chip = el('span', undefined, 'multi-select-chip');
      chip.append(el('span', choice.text));
      if (decorate) decorate(chip, choice.value, choice.text);
      const remove = button(
        '×',
        () => {
          choice.input.checked = false;
          render();
          if (onChange) onChange(currentValues());
          root.dispatchEvent(new Event('change', { bubbles: true }));
        },
        'multi-select-remove',
      );
      remove.dataset.multiRemove = 'true';
      remove.hidden = !editing;
      remove.setAttribute('aria-label', `Remove ${choice.text}`);
      chip.append(remove);
      values.append(chip);
    });
    const query = filter.value.trim().toLowerCase();
    let visible = 0;
    choices.forEach((choice) => {
      const match = !query || choice.text.toLowerCase().includes(query);
      choice.option.hidden = !match;
      if (match) visible++;
    });
    empty.hidden = visible > 0 || !status.hidden;
  }
  controls = {
    root,
    group,
    header,
    edit,
    filter,
    close,
    isOpen: () => !menu.hidden,
    setEntries,
    setStatus,
    select: selectValue,
    selected: currentValues,
  };
  filter.addEventListener('input', () => {
    render();
    invoke(onFilter, filter.value.trim());
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  });
  root.append(values, menu);
  group.append(header, root);
  parent.append(group);
  replaceEntries(entries, selected);
  return controls;
}
export function labelColorPicker(parent, value) {
  const palette = el('fieldset', undefined, 'label-palette');
  palette.append(el('legend', 'Label color'));
  const selected = String(value || '')
    .trim()
    .toLowerCase();
  LABEL_PALETTE.forEach((color) => {
    const input = el('input');
    input.type = 'radio';
    input.name = 'color';
    input.value = color;
    input.checked = color === selected;
    input.setAttribute('aria-label', color);
    input.title = color;
    input.style.backgroundColor = color;
    palette.append(input);
  });
  parent.append(palette);
  return palette;
}
