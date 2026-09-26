// The only application entry point for the generated, same-origin runtime.
import { h, htm, render } from './vendor-preact.js';
export { useLayoutEffect, useRef, useState } from './vendor-preact.js';
export const html = htm.bind(h);

// Each island owns its host's children exclusively. Legacy callers may move or
// remove the host only after unmounting; never patch component-owned children.
const roots = new WeakSet();
export function renderIsland(host, component) {
  const focused = host.contains(document.activeElement) ? document.activeElement : null;
  roots.add(host);
  render(component, host);
  // Moving a keyed DOM node can blur it. Restore only a surviving control,
  // without overriding focus deliberately set by a component's layout effect.
  if (focused?.isConnected && document.activeElement === document.body)
    focused.focus({ preventScroll: true });
}
export function unmountIsland(host) {
  if (!host || !roots.has(host)) return;
  render(null, host);
  roots.delete(host);
}
