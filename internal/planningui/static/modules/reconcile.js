// Keyed patching of rendered nodes, so refreshes keep focus and state.
import { syncAttributes } from './dom.js';

export function patchNode(target, next) {
  if (target === next) return target;
  if (target.tagName !== next.tagName) {
    target.replaceWith(next);
    return next;
  }
  if (
    next.dataset.renderSignature &&
    target.dataset.renderSignature === next.dataset.renderSignature
  )
    return target;
  const details = [...target.querySelectorAll('details')].map((node, index) => ({
    key: node.dataset.stateKey || `details:${index}`,
    open: node.open,
  }));
  syncAttributes(target, next);
  target.replaceChildren(...next.childNodes);
  details.forEach((state) => {
    const node = [...target.querySelectorAll('details')].find(
      (candidate) => (candidate.dataset.stateKey || '') === state.key,
    );
    if (node) node.open = state.open;
  });
  return target;
}
export function keyedNodeKey(node) {
  if (node.dataset.item) return `item:${node.dataset.item}`;
  if (node.dataset.sprintId) return `sprint:${node.dataset.sprintId}`;
  if (node.dataset.column) return `column:${node.dataset.column}`;
  if (node.classList.contains('column-head')) return 'head';
  return node.dataset.empty ? 'empty' : node.className || node.tagName;
}
export function reconcileKeyedChildren(parent, nextNodes, keyOf, patch = patchNode, resolve) {
  const existing = new Map([...parent.children].map((node) => [keyOf(node), node]));
  const used = new Set();
  let cursor = parent.firstElementChild;
  nextNodes.forEach((next) => {
    const key = keyOf(next);
    let target = existing.get(key);
    if (!target && resolve) target = resolve(key, next);
    if (!target || used.has(target)) target = next;
    used.add(target);
    if (target !== cursor) parent.insertBefore(target, cursor);
    if (target !== next) {
      const patched = patch(target, next);
      if (patched && patched !== target) {
        used.delete(target);
        used.add(patched);
        target = patched;
      }
    }
    cursor = target.nextElementSibling;
  });
  while (cursor) {
    const next = cursor.nextElementSibling;
    if (!used.has(cursor)) cursor.remove();
    cursor = next;
  }
}
