// HTM binding and a shallow-props memo built directly on Preact VNodes.
import { Component, h, htm } from './vendor-preact.js';

export const html = htm.bind(h);

/**
 * @template T
 * @param {T} left
 * @param {T} right
 */
export function shallowEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = /** @type {Record<string, unknown>} */ (left);
  const b = /** @type {Record<string, unknown>} */ (right);
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]))
  );
}

// Core Preact has no memo. The class boundary skips a subtree whose props are
// shallow-equal; the wrapped function component keeps its own hooks and still
// updates from its store subscriptions.
/**
 * @template {object} P
 * @param {(props: P) => unknown} render
 * @param {(left: P, right: P) => boolean} [equal]
 * @returns {import('./vendor-preact.js').ComponentType<P>}
 */
export function memo(render, equal = shallowEqual) {
  /** @extends {Component<P>} */
  class Memo extends Component {
    /** @param {P} next */
    shouldComponentUpdate(next) {
      return !equal(this.props, next);
    }
    /** @param {P} props */
    render(props) {
      return h(render, props);
    }
  }
  Memo.displayName = `Memo(${render.name || 'component'})`;
  return Memo;
}
