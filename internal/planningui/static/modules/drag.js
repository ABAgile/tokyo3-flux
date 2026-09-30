// Drag-and-drop of cards, rows and columns as hooks that return event props.
// The dragged record and its preview image are transient browser state kept in
// this module; the planning store holds whether a drag is on, and the pointer
// store the marked target, which changes on every drag-over.
import { useState } from './vendor-preact.js';
import { setState, requireBoard } from './state.js';
import { pointer, setPointer, usePointer } from './pointer-state.js';
import { writable } from './permissions.js';
import { quick } from './commands.js';
import { hideAttachmentTooltip } from './tooltip.js';
import { workspaceSignal } from './workspace-session.js';

/** @type {{ type: string, id: string, revision: number, workspace: AbortSignal } | undefined} */
let session;
/** @type {HTMLElement | undefined} */
let preview;

function endDrag() {
  preview?.remove();
  preview = undefined;
  session = undefined;
  setState({ dragging: false });
  setPointer({ dropTarget: undefined });
}
// Combines event props from several hooks; handlers run in argument order.
/**
 * @param {...Record<string, (event: Event) => void>} list
 * @returns {Record<string, (event: Event) => void>}
 */
export function mergeEventProps(...list) {
  /** @type {Record<string, (event: Event) => void>} */
  const merged = {};
  for (const props of list)
    for (const [name, handler] of Object.entries(props)) {
      const previous = merged[name];
      merged[name] = previous
        ? (event) => {
            previous(event);
            handler(event);
          }
        : handler;
    }
  return merged;
}
// A draggable card, row, column head or list section. `canDrag` is read at
// render and again when the gesture starts.
/**
 * @param {string} type
 * @param {string} id
 * @param {() => boolean} canDrag
 */
export function useDraggable(type, id, canDrag) {
  const [source, setSource] = useState(false);
  const props = {
    draggable: canDrag(),
    onDragStart: (/** @type {Flux.TargetEvent<HTMLElement, DragEvent>} */ event) => {
      const node = event.currentTarget;
      const transfer = /** @type {DataTransfer} */ (event.dataTransfer);
      if (
        !writable() ||
        !canDrag() ||
        (event.target !== node &&
          /** @type {Element | null} */ (event.target)?.closest?.('button,a,input,select,textarea'))
      ) {
        event.preventDefault();
        return;
      }
      event.stopPropagation();
      setSource(true);
      hideAttachmentTooltip();
      session = {
        type,
        id,
        revision: requireBoard().workspace.revision,
        workspace: workspaceSignal(),
      };
      setState({ dragging: true });
      setPointer({ dropTarget: undefined });
      transfer.effectAllowed = 'move';
      transfer.setData('text/plain', id);
      // The drag image is a detached clone of the source, so the native image
      // matches the element without Preact owning the copy.
      const bounds = node.getBoundingClientRect();
      preview?.remove();
      preview = /** @type {HTMLElement} */ (node.cloneNode(true));
      preview.classList.add('drag-source', 'drag-preview');
      preview.dataset.dragPreview = 'true';
      preview.removeAttribute('draggable');
      preview.removeAttribute('data-drag-type');
      preview.setAttribute('aria-hidden', 'true');
      preview.inert = true;
      Object.assign(preview.style, {
        position: 'fixed',
        left: '-10000px',
        top: '0',
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
        margin: '0',
        pointerEvents: 'none',
        zIndex: '-1',
      });
      document.body.append(preview);
      const x =
        event.clientX >= bounds.left && event.clientX < bounds.right
          ? event.clientX - bounds.left
          : bounds.width / 2;
      const y =
        event.clientY >= bounds.top && event.clientY < bounds.bottom
          ? event.clientY - bounds.top
          : bounds.height / 2;
      transfer.setDragImage(preview, x, y);
    },
    onDragEnd: () => {
      setSource(false);
      endDrag();
    },
  };
  return { props, source };
}
/** @type {Record<string, string>} */
const DROP_CLASSES = { before: 'drop-before', after: 'drop-after', end: 'drop-end' };
// A drop target identified by `key`. Each zone accepts one drag `type`, places
// the drop on `axis` ('y', 'x', or 'end' for the whole element) and builds the
// planning command from the dragged id. `enabled()` can refuse at event time.
/**
 * @param {string} key
 * @param {readonly Flux.DropZone[]} zones
 */
export function useDropZone(key, zones) {
  const mark = usePointer((current) =>
    current.dropTarget?.key === key ? current.dropTarget.mark : '',
  );
  const zoneFor = () => {
    const dragged = session;
    return dragged && !dragged.workspace.aborted && writable()
      ? zones.find((zone) => zone.type === dragged.type && (zone.enabled?.() ?? true))
      : undefined;
  };
  const after = (
    /** @type {Flux.TargetEvent<HTMLElement, DragEvent>} */ event,
    /** @type {Flux.DropZone} */ zone,
  ) => {
    const r = event.currentTarget.getBoundingClientRect();
    return zone.axis === 'x'
      ? event.clientX > r.left + r.width / 2
      : event.clientY > r.top + r.height / 2;
  };
  const props = {
    onDragOver: (/** @type {Flux.TargetEvent<HTMLElement, DragEvent>} */ event) => {
      const zone = zoneFor();
      if (!zone) return;
      event.preventDefault();
      event.stopPropagation();
      /** @type {DataTransfer} */ (event.dataTransfer).dropEffect = 'move';
      const next = zone.axis === 'end' ? 'end' : after(event, zone) ? 'after' : 'before';
      if (pointer.dropTarget?.key !== key || pointer.dropTarget.mark !== next)
        setPointer({ dropTarget: { key, mark: next } });
    },
    onDragLeave: (/** @type {Flux.TargetEvent<HTMLElement, DragEvent>} */ event) => {
      if (
        !event.currentTarget.contains(/** @type {Node | null} */ (event.relatedTarget)) &&
        pointer.dropTarget?.key === key
      )
        setPointer({ dropTarget: undefined });
    },
    onDrop: (/** @type {Flux.TargetEvent<HTMLElement, DragEvent>} */ event) => {
      const zone = zoneFor();
      if (!zone || !session) return;
      event.preventDefault();
      event.stopPropagation();
      const command = zone.command(session.id, after(event, zone));
      const revision = session.revision;
      endDrag();
      if (command && command.target !== command.before) quick({ ...command, revision });
    },
  };
  return { props, className: DROP_CLASSES[mark] || '' };
}
