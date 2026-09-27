// Drag-and-drop of cards, rows and columns as hooks that return event props.
// The dragged record and its preview image are transient browser state kept in
// this module; the planning store holds whether a drag is on, and the pointer
// store the marked target, which changes on every drag-over.
import { useState } from './vendor-preact.js';
import { setState, state } from './state.js';
import { pointer, setPointer, usePointer } from './pointer-state.js';
import { writable } from './permissions.js';
import { quick } from './commands.js';
import { hideAttachmentTooltip } from './tooltip.js';
import { workspaceSignal } from './workspace-session.js';

let session;
let preview;

function endDrag() {
  preview?.remove();
  preview = undefined;
  session = undefined;
  setState({ dragging: false });
  setPointer({ dropTarget: undefined });
}
// Combines event props from several hooks; handlers run in argument order.
export function mergeEventProps(...list) {
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
export function useDraggable(type, id, canDrag) {
  const [source, setSource] = useState(false);
  const props = {
    draggable: canDrag(),
    onDragStart: (event) => {
      const node = event.currentTarget;
      if (
        !writable() ||
        !canDrag() ||
        (event.target !== node && event.target.closest?.('button,a,input,select,textarea'))
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
        revision: state.board.workspace.revision,
        workspace: workspaceSignal(),
      };
      setState({ dragging: true });
      setPointer({ dropTarget: undefined });
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
      // The drag image is a detached clone of the source, so the native image
      // matches the element without Preact owning the copy.
      const bounds = node.getBoundingClientRect();
      preview?.remove();
      preview = node.cloneNode(true);
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
      event.dataTransfer.setDragImage(preview, x, y);
    },
    onDragEnd: () => {
      setSource(false);
      endDrag();
    },
  };
  return { props, source };
}
const DROP_CLASSES = { before: 'drop-before', after: 'drop-after', end: 'drop-end' };
// A drop target identified by `key`. Each zone accepts one drag `type`, places
// the drop on `axis` ('y', 'x', or 'end' for the whole element) and builds the
// planning command from the dragged id. `enabled()` can refuse at event time.
export function useDropZone(key, zones) {
  const mark = usePointer((current) =>
    current.dropTarget?.key === key ? current.dropTarget.mark : '',
  );
  const zoneFor = () =>
    session && !session.workspace.aborted && writable()
      ? zones.find((zone) => zone.type === session.type && (zone.enabled?.() ?? true))
      : undefined;
  const after = (event, zone) => {
    const r = event.currentTarget.getBoundingClientRect();
    return zone.axis === 'x'
      ? event.clientX > r.left + r.width / 2
      : event.clientY > r.top + r.height / 2;
  };
  const props = {
    onDragOver: (event) => {
      const zone = zoneFor();
      if (!zone) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      const next = zone.axis === 'end' ? 'end' : after(event, zone) ? 'after' : 'before';
      if (pointer.dropTarget?.key !== key || pointer.dropTarget.mark !== next)
        setPointer({ dropTarget: { key, mark: next } });
    },
    onDragLeave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget) && pointer.dropTarget?.key === key)
        setPointer({ dropTarget: undefined });
    },
    onDrop: (event) => {
      const zone = zoneFor();
      if (!zone) return;
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
