// HTM binding and a shallow-props memo built directly on Preact VNodes.
import { Component, h, htm } from './vendor-preact.js';

export const html = htm.bind(h);

export function shallowEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
  );
}

// Core Preact has no memo. The class boundary skips a subtree whose props are
// shallow-equal; the wrapped function component keeps its own hooks and still
// updates from its store subscriptions.
export function memo(render, equal = shallowEqual) {
  class Memo extends Component {
    shouldComponentUpdate(next) {
      return !equal(this.props, next);
    }
    render(props) {
      return h(render, props);
    }
  }
  Memo.displayName = `Memo(${render.name || 'component'})`;
  return Memo;
}
