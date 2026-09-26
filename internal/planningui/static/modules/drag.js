// Drag-and-drop of cards, rows and columns.
import { state } from './state.js';
import { writable } from './permissions.js';
import { findItem } from './items.js';
import { quick } from './commands.js';
import { hideAttachmentTooltip } from './item-attachments.js';

function clearDropMarks() {
  document
    .querySelectorAll('.drop-before,.drop-after,.drop-end')
    .forEach((e) => e.classList.remove('drop-before', 'drop-after', 'drop-end'));
}
export function makeDraggable(node, type, id, name) {
  node.dataset.dragType = type;
  node.setAttribute('aria-label', `Drag ${type} ${name}`);
  return attachDrag(node, type, id);
}
// The drag listeners alone, for elements whose attributes a template renders.
// `draggable` is set here and afterwards maintained by renderControls.
export function attachDrag(node, type, id) {
  node.draggable = writable() && !(type === 'card' && findItem(id)?.archived);
  node.addEventListener('dragstart', (e) => {
    if (
      !writable() ||
      (type === 'card' && findItem(id)?.archived) ||
      (e.target !== node && e.target.closest?.('button,a,input,select,textarea'))
    ) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    node.classList.add('drag-source');
    state.observationTooltipTarget = undefined;
    hideAttachmentTooltip();
    state.drag = { type, id, revision: state.board.workspace.revision, root: state.root };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    const bounds = node.getBoundingClientRect();
    state.dragPreview?.remove();
    state.dragPreview = node.cloneNode(true);
    state.dragPreview.classList.add('drag-preview');
    state.dragPreview.dataset.dragPreview = 'true';
    state.dragPreview.removeAttribute('draggable');
    state.dragPreview.removeAttribute('data-drag-type');
    state.dragPreview.setAttribute('aria-hidden', 'true');
    state.dragPreview.inert = true;
    Object.assign(state.dragPreview.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      margin: '0',
      pointerEvents: 'none',
      zIndex: '-1',
    });
    document.body.append(state.dragPreview);
    const x =
      e.clientX >= bounds.left && e.clientX < bounds.right
        ? e.clientX - bounds.left
        : bounds.width / 2;
    const y =
      e.clientY >= bounds.top && e.clientY < bounds.bottom
        ? e.clientY - bounds.top
        : bounds.height / 2;
    e.dataTransfer.setDragImage(state.dragPreview, x, y);
  });
  node.addEventListener('dragend', () => {
    node.classList.remove('drag-source');
    state.dragPreview?.remove();
    state.dragPreview = undefined;
    state.drag = undefined;
    clearDropMarks();
  });
  return node;
}
export function dropZone(node, type, command, axis = 'y') {
  function accepts() {
    return (
      state.drag?.type === type &&
      state.drag.root === state.root &&
      writable() &&
      !(type === 'card' && findItem(node.dataset.item)?.archived)
    );
  }
  function after(e) {
    const r = node.getBoundingClientRect();
    return axis === 'x' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
  }
  node.addEventListener('dragover', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    node.classList.add(axis === 'end' ? 'drop-end' : after(e) ? 'drop-after' : 'drop-before');
  });
  node.addEventListener('dragleave', (e) => {
    if (!node.contains(e.relatedTarget))
      node.classList.remove('drop-before', 'drop-after', 'drop-end');
  });
  node.addEventListener('drop', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    e.stopPropagation();
    const c = command(state.drag.id, after(e));
    const revision = state.drag.revision;
    state.drag = undefined;
    clearDropMarks();
    if (c && c.target !== c.before) quick({ ...c, revision });
  });
}
