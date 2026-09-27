// Geometry-positioned tooltips. Triggers spread the props a hook returns; the
// attachment tooltip is one layer rendering `{ text, anchor, target }` from the
// pointer store, and observation icons position their own CSS tooltip.
import { html } from './vdom.js';
import { useEffect, useLayoutEffect, useRef, useState } from './vendor-preact.js';
import { uid } from './dom.js';
import { pointer, setPointer, usePointer } from './pointer-state.js';
import { useEventListener } from './ui-hooks.js';

function spacing() {
  const rootStyle = getComputedStyle(document.documentElement);
  return {
    gap: Number.parseFloat(rootStyle.getPropertyValue('--s1')) || 4,
    edge: Number.parseFloat(rootStyle.getPropertyValue('--s4')) || 16,
  };
}
function box(element) {
  const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
  return { left, top, right, bottom, width, height };
}
// Hover and focus state for a trigger; `onChange(active)` hears transitions.
function useHoverFocus(onChange) {
  const hovered = useRef(false);
  const focused = useRef(false);
  const update = () => onChange(hovered.current || focused.current);
  return {
    onPointerEnter: () => {
      hovered.current = true;
      update();
    },
    onPointerLeave: () => {
      hovered.current = false;
      update();
    },
    onFocus: () => {
      focused.current = true;
      update();
    },
    onBlur: () => {
      focused.current = false;
      update();
    },
  };
}

export function hideAttachmentTooltip() {
  if (pointer.attachmentTooltip) setPointer({ attachmentTooltip: undefined });
}
// The trigger `ref` and the `anchorRef` the tooltip aligns with. Resize and
// scroll listeners are installed only while this trigger's tooltip is shown.
export function useAttachmentTooltip(text) {
  const [owner] = useState(() => uid('attachment-tooltip-owner'));
  const ref = useRef(null);
  const anchorRef = useRef(null);
  const active = usePointer((current) => current.attachmentTooltip?.owner === owner);
  const hide = () => {
    if (pointer.attachmentTooltip?.owner === owner) setPointer({ attachmentTooltip: undefined });
  };
  const show = () => {
    const target = ref.current;
    const dialog = target?.closest('dialog');
    if (!target?.isConnected || !text || (dialog && !dialog.open)) {
      hide();
      return;
    }
    setPointer({
      attachmentTooltip: {
        owner,
        text,
        inDialog: dialog?.id === 'editor',
        anchor: box(anchorRef.current || target),
        target: box(target),
      },
    });
  };
  const props = useHoverFocus((on) => (on ? show() : hide()));
  useEventListener(window, 'resize', show, { active });
  useEventListener(document, 'scroll', show, { active, capture: true });
  useEffect(
    () => () => {
      if (pointer.attachmentTooltip?.owner === owner) setPointer({ attachmentTooltip: undefined });
    },
    [],
  );
  return { ref, anchorRef, active, props };
}
function selectAttachmentTooltip(current) {
  return current.attachmentTooltip;
}
// Rendered once at the body and once inside the editor dialog, whose top layer
// would otherwise cover it.
export function AttachmentTooltip({ inDialog = false }) {
  const tooltip = usePointer(selectAttachmentTooltip);
  const node = useRef();
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const shown = !!tooltip && tooltip.inDialog === inDialog;
  useLayoutEffect(() => {
    if (!shown || !node.current) return;
    const { gap, edge } = spacing();
    const size = node.current.getBoundingClientRect();
    const maxLeft = Math.max(edge, innerWidth - size.width - edge);
    const left = Math.round(Math.min(Math.max(edge, tooltip.anchor.left), maxLeft));
    const top = Math.round(
      Math.min(
        Math.max(edge, tooltip.target.bottom + gap),
        Math.max(edge, innerHeight - size.height - edge),
      ),
    );
    setPosition((current) =>
      current.left === left && current.top === top ? current : { left, top },
    );
  });
  if (!shown) return null;
  return html`<span
    id="attachment-tooltip"
    class="attachment-tooltip"
    role="tooltip"
    ref=${node}
    style=${{ left: `${position.left}px`, top: `${position.top}px` }}
  >${tooltip.text}</span>`;
}

// An observation icon's tooltip is its own CSS ::after box, placed through
// custom properties computed while the icon is hovered or focused.
export function useObservationTooltip() {
  const ref = useRef(null);
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState(undefined);
  const place = () => {
    const target = ref.current;
    if (!target?.isConnected) return;
    const tooltipStyle = getComputedStyle(target, '::after');
    const width = Number.parseFloat(tooltipStyle.width) || 320;
    const height = Number.parseFloat(tooltipStyle.height) || 0;
    const { gap, edge } = spacing();
    const targetBox = target.getBoundingClientRect();
    const maxLeft = Math.max(edge, innerWidth - width - edge);
    const left = Math.round(Math.min(Math.max(edge, targetBox.left), maxLeft));
    const below = targetBox.bottom + gap;
    const top = Math.round(
      below + height <= innerHeight - edge ? below : Math.max(edge, targetBox.top - gap - height),
    );
    setPosition((current) =>
      current?.left === left && current?.top === top ? current : { left, top },
    );
  };
  const props = useHoverFocus((on) => {
    setActive(on);
    if (on) place();
  });
  useEventListener(window, 'resize', place, { active });
  useEventListener(document, 'scroll', place, { active, capture: true });
  const style = position
    ? {
        '--observation-tooltip-left': `${position.left}px`,
        '--observation-tooltip-top': `${position.top}px`,
      }
    : undefined;
  return { ref, props, style };
}
