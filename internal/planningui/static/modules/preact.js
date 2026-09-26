// Same-origin Preact + HTM, without JSX, eval, or an application build step.
import { h, htm, Fragment, render as preactRender } from './vendor-preact.js';
export { useEffect, useLayoutEffect, useRef, useState, useMemo } from './vendor-preact.js';
export const html = htm.bind(h);
export const nothing = null;

export function withKey(key, children) {
  return h(Fragment, { key }, children);
}
export function keyedList(values, key, view) {
  return values.map((value, index) => withKey(key(value, index), view(value, index)));
}
export function classNames(classes) {
  return Object.keys(classes)
    .filter((name) => classes[name])
    .join(' ');
}

const roots = new WeakMap();
const detachedRoots = new WeakMap();
const initialized = new WeakSet();
const disposed = new WeakSet();

// One-time, element-local setup (drag/drop listeners or initial form values).
// Pass stable identities and read current domain data in event handlers.
// External resources belong in component effects with explicit cleanup.
export function attach(setup, ...args) {
  return (node) => {
    if (!node || initialized.has(node)) return;
    initialized.add(node);
    setup(node, ...args);
  };
}
// Busy/permission controls are also updated by renderControls between renders.
// A ref compares against the real property, not Preact's previous VNode props.
export function syncDisabled(disabled) {
  return (node) => {
    if (node) node.disabled = !!disabled;
  };
}

export function render(template, host) {
  if (disposed.has(host)) return;
  if (!roots.has(host)) {
    host.replaceChildren();
    roots.set(host, { container: host });
  }
  const focused = host.contains(document.activeElement) ? document.activeElement : null;
  preactRender(template, host);
  // Same-parent keys preserve nodes; moving a card between columns changes
  // parents and remounts it. Recover its logical focus target in either case,
  // without overriding focus deliberately set by a component's layout effect.
  if (focused && document.activeElement === document.body) {
    const key = focused.dataset?.focusKey;
    const target = focused.isConnected
      ? focused
      : key
        ? host.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)
        : null;
    target?.focus({ preventScroll: true });
  }
}
export function renderIsland(host, template) {
  disposed.delete(host);
  render(template, host);
}
// Dispose nested controller roots before their owner. Also supports nodes
// created by nodeOf and then moved into a static shell host.
export function unmountIsland(host) {
  if (!host) return;
  const nodes = [host, ...host.querySelectorAll('*')].reverse();
  for (const node of nodes) {
    const root = roots.get(node);
    if (root) {
      roots.delete(node);
      disposed.add(node);
      preactRender(null, root.container);
    }
    const detached = detachedRoots.get(node);
    if (detached) {
      detachedRoots.delete(node);
      preactRender(null, detached);
    }
  }
}
export function replaceContent(host, ...children) {
  unmountIsland(host);
  host.replaceChildren(...children);
}
// A fresh dialog/form mount. Updates after disposal are ignored, including
// responses that complete after another item or workspace has been opened.
export function mount(host, template) {
  replaceContent(host);
  disposed.delete(host);
  render(template, host);
  const root = roots.get(host);
  return (next) => {
    if (roots.get(host) === root && !disposed.has(host)) render(next, host);
  };
}
// Only for static shell slots and rendered-once form skeletons; never put DOM
// nodes inside an HTM expression. Re-rendered subtrees use VNodes exclusively.
export function nodeOf(template) {
  const fragment = document.createDocumentFragment();
  preactRender(template, fragment);
  const node = fragment.firstElementChild;
  if (node) detachedRoots.set(node, fragment);
  return node;
}
