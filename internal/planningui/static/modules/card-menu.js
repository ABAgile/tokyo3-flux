// A board card's "⋯" actions menu: Copy link, and Move to, which cascades into
// the columns and then into Top or Bottom of the chosen one. Moving reuses the
// drop commands, so it is applied optimistically, offers Undo and respects WIP
// limits like a drag does.
import { html } from './vdom.js';
import { useEffect, useLayoutEffect, useRef, useState } from './vendor-preact.js';
import { useStore } from './state.js';
import { quick } from './commands.js';
import { filteredItems } from './filters.js';
import { copyCardLink } from './url-state.js';
import { useDebouncedValue, useDismiss, useEventListener } from './ui-hooks.js';

const GAP = 4;
const EDGE = 8;
// How long the pointer must rest on a column before its Top and Bottom follow
// it, so crossing other columns on the way to them does not switch the list.
const HOVER_DELAY = 120;

/** @typedef {{ left: number, right: number, top: number, bottom: number }} Box */
// Where a fixed-position menu goes. A root menu hangs below its trigger with
// the right edges aligned (or the left edges, for a trigger at the start of its
// row), or above when there is no room below; a submenu opens beside the item
// it belongs to, on the other side when the first has no room. Either way it
// stays inside the viewport.
/**
 * @param {{
 *   anchor: Box,
 *   size: { width: number, height: number },
 *   viewport: { width: number, height: number },
 *   beside: boolean,
 *   align?: 'start' | 'end',
 * }} request
 */
export function placeMenu({ anchor, size, viewport, beside, align = 'end' }) {
  /** @param {number} value @param {number} extent @param {number} room */
  const keep = (value, extent, room) => Math.max(EDGE, Math.min(value, room - extent - EDGE));
  if (beside) {
    const right = anchor.right + GAP;
    const left =
      right + size.width + EDGE <= viewport.width ? right : anchor.left - GAP - size.width;
    return {
      left: Math.round(keep(left, size.width, viewport.width)),
      top: Math.round(keep(anchor.top - GAP, size.height, viewport.height)),
    };
  }
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - size.height;
  const top = below + size.height + EDGE <= viewport.height || above < EDGE ? below : above;
  return {
    left: Math.round(
      keep(align === 'start' ? anchor.left : anchor.right - size.width, size.width, viewport.width),
    ),
    top: Math.round(keep(top, size.height, viewport.height)),
  };
}

// The columns a card can be moved to, with whether each is at its WIP limit.
// One list is shared by every open menu: it is computed once per change of the
// columns or items, and a menu re-renders only when a flag in it changes.
/** @typedef {{ id: string, name: string, full: boolean }} MoveTarget */
/** @type {MoveTarget[]} */
const NO_TARGETS = [];
/** @type {{ columns: readonly Flux.Column[], items: readonly Flux.Item[], targets: MoveTarget[] } | undefined} */
let targetsCache;
/** @param {Flux.State} current */
function selectMoveTargets(current) {
  const board = current.board;
  if (!board) return NO_TARGETS;
  if (targetsCache?.columns === board.columns && targetsCache.items === board.items)
    return targetsCache.targets;
  /** @type {Map<string, number>} */
  const load = new Map();
  for (const item of board.items)
    if (!item.archived) load.set(item.column_id, (load.get(item.column_id) || 0) + 1);
  const targets = board.columns.map((column) => ({
    id: column.id,
    name: column.name,
    full: column.wip > 0 && (load.get(column.id) || 0) >= column.wip,
  }));
  targetsCache = { columns: board.columns, items: board.items, targets };
  return targets;
}
/**
 * @param {readonly MoveTarget[]} a
 * @param {readonly MoveTarget[]} b
 */
function sameTargets(a, b) {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((t, i) => t.id === b[i].id && t.name === b[i].name && t.full === b[i].full))
  );
}

// The move for a column and an end of it. Bottom is the column's end, like a
// drop on the column. Top goes before the first card shown there, as dropping
// on the upper half of that card would; with filters active, cards hidden by
// them are not counted, exactly as for a drop.
/**
 * @param {Flux.Item} item
 * @param {string} destination
 * @param {'top' | 'bottom'} where
 * @returns {Flux.Command}
 */
function moveCommand(item, destination, where) {
  const first =
    where === 'top'
      ? filteredItems().find((peer) => peer.column_id === destination && peer.id !== item.id)
      : undefined;
  return first
    ? { kind: 'item.move', target: item.id, destination, before: first.id }
    : { kind: 'item.move', target: item.id, destination };
}

/** @typedef {{ current: HTMLElement | null }} ElementRef */
// A fixed-position menu measured in a layout effect, so it is neither clipped
// by the card's scrolling column nor visible before it has a place. Until then
// it is transparent rather than hidden, which would stop it taking focus.
/**
 * @param {{
 *   anchor: ElementRef,
 *   beside: boolean,
 *   align?: 'start' | 'end',
 *   label: string,
 *   onKeyDown: (event: KeyboardEvent) => void,
 *   onMove?: () => void,
 *   children?: unknown,
 * }} props
 */
function Popup({ anchor, beside, align, label, onKeyDown, onMove, children }) {
  const node = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [at, setAt] = useState(
    /** @type {{ left: number, top: number } | undefined} */ (undefined),
  );
  useLayoutEffect(() => {
    if (!anchor.current || !node.current) return;
    const next = placeMenu({
      anchor: anchor.current.getBoundingClientRect(),
      size: node.current.getBoundingClientRect(),
      viewport: { width: innerWidth, height: innerHeight },
      beside,
      align,
    });
    setAt((current) => (current?.left === next.left && current.top === next.top ? current : next));
  });
  const style = at
    ? { left: `${at.left}px`, top: `${at.top}px` }
    : { left: '0px', top: '0px', opacity: '0' };
  // The card behind the menu opens its editor on a click and starts a drag; the
  // menu's gaps and padding must do neither.
  return html`<div
    class=${beside ? 'card-menu card-submenu' : 'card-menu'}
    role="menu"
    aria-label=${label}
    ref=${node}
    style=${style}
    onKeydown=${onKeyDown}
    onMouseMove=${onMove}
    onClick=${(/** @type {MouseEvent} */ event) => event.stopPropagation()}
    onDragStart=${(/** @type {DragEvent} */ event) => {
      event.preventDefault();
      event.stopPropagation();
    }}
  >${children}</div>`;
}
// Arrow, Home and End keys move among a menu's items; true when handled.
/**
 * @param {KeyboardEvent} event
 * @param {readonly (HTMLElement | null)[]} items
 */
function navigate(event, items) {
  const list = items.filter(
    /** @type {(node: HTMLElement | null) => node is HTMLElement} */ ((node) => !!node),
  );
  const at = list.indexOf(/** @type {HTMLElement} */ (event.target));
  /** @type {number | undefined} */
  let next;
  if (event.key === 'ArrowDown') next = (at + 1) % list.length;
  else if (event.key === 'ArrowUp') next = (at <= 0 ? list.length : at) - 1;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = list.length - 1;
  if (next === undefined) return false;
  event.preventDefault();
  list[next]?.focus({ preventScroll: true });
  return true;
}

/** @typedef {{ where: string, nonce: number }} FocusRequest */
/** @typedef {'top' | 'bottom'} End */
// The last level: Top or Bottom of the chosen column. It takes focus when it is
// opened by a click, Enter or Right; opened by the pointer resting on its
// column, it leaves focus where it was.
/**
 * @param {{
 *   column: MoveTarget,
 *   anchor: ElementRef,
 *   focus: boolean,
 *   onPick: (where: End) => void,
 *   onBack: () => void,
 *   onMove: () => void,
 * }} props
 */
function EndList({ column, anchor, focus, onPick, onBack, onMove }) {
  const entries = useRef(/** @type {(HTMLButtonElement | null)[]} */ ([]));
  useLayoutEffect(() => {
    if (focus) entries.current[0]?.focus({ preventScroll: true });
  }, [focus]);
  const keys = (/** @type {KeyboardEvent} */ event) => {
    if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      onBack();
    } else if (navigate(event, entries.current)) event.stopPropagation();
  };
  /** @type {[End, string][]} */
  const ends = [
    ['top', 'Top'],
    ['bottom', 'Bottom'],
  ];
  return html`<${Popup} anchor=${anchor} beside=${true} label=${`Position in ${column.name}`} onKeyDown=${keys} onMove=${onMove}>
    ${ends.map(
      ([where, text], index) => html`<button
        key=${where}
        type="button"
        class="card-menu-item"
        role="menuitem"
        ref=${(/** @type {HTMLButtonElement | null} */ node) => {
          entries.current[index] = node;
        }}
        onClick=${() => onPick(where)}
      >${text}</button>`,
    )}
  </${Popup}>`;
}
// The cascade: one entry per column. The card's own column leads the list,
// unavailable, as its heading; the columns it can move to follow a divider in
// board order, each opening its Top and Bottom. A column at its WIP limit stays
// in the list, announced as unavailable, so it is clear why it cannot be picked.
/**
 * @param {{
 *   item: Flux.Item,
 *   anchor: ElementRef,
 *   focus: FocusRequest,
 *   onPick: (id: string, where: End) => void,
 *   onBack: () => void,
 * }} props
 */
function MoveList({ item, anchor, focus, onPick, onBack }) {
  const targets = useStore(selectMoveTargets, sameTargets);
  const entries = useRef(/** @type {(HTMLButtonElement | null)[]} */ ([]));
  // The column whose Top and Bottom are open, and whether they were opened by
  // a click or key rather than by the pointer resting on the column.
  const [chosen, setChosen] = useState({ id: '', focus: false });
  // The column the pointer is on; it is cleared on leaving and restored on
  // reaching that column's Top and Bottom, and only a pointer that stays on
  // another column for a moment changes the list, so brushing past columns on
  // the way to it does not. It follows pointer movement, not enter events: the
  // browser also raises those when a menu appears under a pointer at rest,
  // which must not override a choice made with the keyboard.
  const [hovered, setHovered] = useState('');
  const settled = useDebouncedValue(hovered, HOVER_DELAY);
  // Only a change of the settled column counts: on mount it is empty, and
  // acting on that would close a list a fast key press has just opened.
  const lastSettled = useRef('');
  useEffect(() => {
    if (lastSettled.current === settled) return;
    lastSettled.current = settled;
    setChosen((current) => (current.id === settled ? current : { id: settled, focus: false }));
  }, [settled]);
  const here = targets.find((target) => target.id === item.column_id);
  const others = targets.filter((target) => target.id !== item.column_id);
  const ordered = here ? [here, ...others] : others;
  const available = (/** @type {MoveTarget} */ target) =>
    target.id !== item.column_id && !target.full;
  useLayoutEffect(() => {
    if (focus.where !== 'sub') return;
    const first = ordered.findIndex(available);
    entries.current[Math.max(first, 0)]?.focus({ preventScroll: true });
  }, [focus]);
  const keys = (/** @type {KeyboardEvent} */ event) => {
    if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      onBack();
    } else if (event.key === 'ArrowRight') {
      const row = ordered[entries.current.indexOf(/** @type {HTMLButtonElement} */ (event.target))];
      if (!row || !available(row)) return;
      event.preventDefault();
      setChosen({ id: row.id, focus: true });
    } else if (navigate(event, entries.current)) {
      event.stopPropagation();
      setChosen({ id: '', focus: false });
    }
  };
  const entry = (/** @type {MoveTarget} */ target, /** @type {number} */ index) => {
    const current = target.id === item.column_id;
    const open = available(target);
    return html`<button
      key=${target.id}
      type="button"
      class=${current ? 'card-menu-item is-current' : 'card-menu-item'}
      role="menuitem"
      aria-haspopup=${open ? 'menu' : null}
      aria-expanded=${open ? String(chosen.id === target.id) : null}
      aria-disabled=${open ? null : 'true'}
      ref=${(/** @type {HTMLButtonElement | null} */ node) => {
        entries.current[index] = node;
      }}
      onMouseMove=${() => setHovered(open ? target.id : '')}
      onMouseLeave=${() => setHovered('')}
      onClick=${() => open && setChosen({ id: target.id, focus: true })}
    >${target.name}${
      current
        ? html`<span class="card-menu-note">current</span>`
        : target.full
          ? html`<span class="card-menu-note">full</span>`
          : html`<span class="card-menu-arrow" aria-hidden="true">▸</span>`
    }</button>`;
  };
  const at = ordered.findIndex((target) => target.id === chosen.id);
  return html`<${Popup} anchor=${anchor} beside=${true} label="Move to" onKeyDown=${keys}>
    ${here ? entry(here, 0) : null}
    ${here && others.length ? html`<div class="card-menu-separator" role="separator"></div>` : null}
    ${others.map((target, index) => entry(target, (here ? 1 : 0) + index))}
    ${
      at >= 0
        ? html`<${EndList}
            key=${chosen.id}
            column=${ordered[at]}
            anchor=${{ current: entries.current[at] }}
            focus=${chosen.focus}
            onMove=${() => setHovered(chosen.id)}
            onPick=${(/** @type {End} */ where) => onPick(chosen.id, where)}
            onBack=${() => {
              setChosen({ id: '', focus: false });
              entries.current[at]?.focus({ preventScroll: true });
            }}
          />`
        : null
    }
  </${Popup}>`;
}

// `align` is the edge of the button the menu lines up with: 'end' for a button
// at the end of a card's title row, 'start' for one at the start of a List row.
/** @param {{ item: Flux.Item, canMove: boolean, disabled: boolean, align?: 'start' | 'end' }} props */
export function CardMenu({ item, canMove, disabled, align = 'end' }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState(false);
  const [focus, setFocus] = useState(/** @type {FocusRequest} */ ({ where: '', nonce: 0 }));
  const wrapper = useRef(/** @type {HTMLSpanElement | null} */ (null));
  const trigger = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const rootItems = useRef(/** @type {(HTMLButtonElement | null)[]} */ ([]));
  const move = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const ask = (/** @type {string} */ where) =>
    setFocus((current) => ({ where, nonce: current.nonce + 1 }));
  const close = (/** @type {boolean} */ restoreFocus) => {
    setOpen(false);
    setSub(false);
    if (restoreFocus) ask('trigger');
  };
  useLayoutEffect(() => {
    if (focus.where === 'trigger') trigger.current?.focus({ preventScroll: true });
    else if (focus.where === 'root') rootItems.current[0]?.focus({ preventScroll: true });
    else if (focus.where === 'move') move.current?.focus({ preventScroll: true });
  }, [focus]);
  useDismiss(wrapper, open, () => close(false), { closeOnEscape: false });
  // A fixed menu would be left behind by anything that scrolls or resizes.
  useEventListener(window, 'resize', () => close(false), { active: open });
  useEventListener(document, 'scroll', () => close(false), { active: open, capture: true });
  const toggle = () => {
    if (open) return close(true);
    setOpen(true);
    ask('root');
  };
  const rootKeys = (/** @type {KeyboardEvent} */ event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') close(false);
    else if (canMove && event.key === 'ArrowRight' && event.target === move.current) {
      event.preventDefault();
      setSub(true);
      ask('sub');
    } else navigate(event, rootItems.current);
  };
  const triggerKeys = (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'ArrowDown' || open) return;
    event.preventDefault();
    toggle();
  };
  const label = `Actions for “${item.title}”`;
  return html`<span class="card-menu-wrap" ref=${wrapper}>
    <button
      type="button"
      class="card-menu-trigger"
      aria-label=${label}
      title="Card actions"
      aria-haspopup="menu"
      aria-expanded=${String(open)}
      data-focus-key=${`item:${item.id}:menu`}
      ref=${trigger}
      onClick=${toggle}
      onKeydown=${triggerKeys}
    >⋯</button>
    ${
      open
        ? html`<${Popup} anchor=${trigger} beside=${false} align=${align} label=${label} onKeyDown=${rootKeys}>
            <button
              type="button"
              class="card-menu-item"
              role="menuitem"
              ref=${(/** @type {HTMLButtonElement | null} */ node) => {
                rootItems.current[0] = node;
              }}
              onMouseMove=${() => setSub(false)}
              onClick=${() => {
                close(true);
                void copyCardLink(item);
              }}
            >Copy link</button>
            ${
              canMove
                ? html`<button
                    type="button"
                    class="card-menu-item"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded=${String(sub)}
                    aria-disabled=${disabled ? 'true' : null}
                    ref=${(/** @type {HTMLButtonElement | null} */ node) => {
                      rootItems.current[1] = node;
                      move.current = node;
                    }}
                    onMouseMove=${() => !disabled && setSub(true)}
                    onClick=${() => {
                      if (disabled) return;
                      setSub(true);
                      ask('sub');
                    }}
                  >Move to<span class="card-menu-arrow" aria-hidden="true">▸</span></button>`
                : null
            }
            ${
              canMove && sub && !disabled
                ? html`<${MoveList}
                    item=${item}
                    anchor=${move}
                    focus=${focus}
                    onPick=${(/** @type {string} */ destination, /** @type {End} */ where) => {
                      close(true);
                      void quick(moveCommand(item, destination, where));
                    }}
                    onBack=${() => {
                      setSub(false);
                      ask('move');
                    }}
                  />`
                : null
            }
          </${Popup}>`
        : null
    }
  </span>`;
}
