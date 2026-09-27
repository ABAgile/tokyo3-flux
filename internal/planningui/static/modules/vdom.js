// HTM binding and keyed-list helpers built directly on Preact VNodes.
import { Fragment, h, htm } from './vendor-preact.js';

export const html = htm.bind(h);

export function withKey(key, children) {
  return h(Fragment, { key }, children);
}

export function keyedList(values, key, view) {
  return values.map((value, index) => withKey(key(value, index), view(value, index)));
}
