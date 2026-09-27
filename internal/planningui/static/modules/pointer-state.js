// Pointer state that changes at event rate: the drop zone marked during a drag
// and the attachment tooltip shown on hover. It has its own small store, so a
// drag-over or hover notifies only drop zones and tooltip triggers rather than
// every subscriber of the planning state. Like that store, it holds data only.
import { createStore } from './store.js';

/** @type {Flux.PointerState} */
const initialPointer = {
  // The drop zone currently marked: { key, mark }.
  dropTarget: undefined,
  // The attachment tooltip shown by a tile link: { owner, text, anchor, target, inDialog }.
  attachmentTooltip: undefined,
};

const { state: pointer, setState: setPointer, useStore: usePointer } = createStore(initialPointer);
export { pointer, setPointer, usePointer };
