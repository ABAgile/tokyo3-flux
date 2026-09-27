// The App owns both persistent content mounts. The legacy planning renderer
// writes only into the planning body while that view is being migrated.
import { $ } from './dom.js';
import { state } from './state.js';

export function planningHost() {
  return $('planning-body');
}
export function setContentBusy(value) {
  state.contentBusy = !!value;
}
