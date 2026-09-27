// The App binds aria-busy to the active content body from shared state.
import { state } from './state.js';

export function setContentBusy(value) {
  state.contentBusy = !!value;
}
