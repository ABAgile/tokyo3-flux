// Focus changes as state. An action that moves focus stores a request in the
// same patch as the change that renders its target; the component rendering
// the target consumes it in a layout effect, once that render has committed.
// This relies on commit order only, never on when Preact schedules renders.
import { useLayoutEffect } from './vendor-preact.js';
import { setState, state, useStore } from './state.js';
import { focusKey } from './ui-hooks.js';

let sequence = 0;
// The store patch requesting focus for the control with logical focus `key`.
// `scope` names the consumer that renders it, for example 'list'.
export function focusRequestPatch(scope, key) {
  sequence += 1;
  return { focusRequest: key ? { scope, key, nonce: sequence } : undefined };
}
export function clearFocusRequest(request) {
  setState((current) =>
    current.focusRequest === request ? { focusRequest: undefined } : undefined,
  );
}
function selectFocusRequest(current) {
  return current.focusRequest;
}
// Consumes this scope's request after the calling component committed, looking
// for the target inside `ref`. A request whose target is gone is dropped. While
// a modal dialog is open the rest of the page is inert, so the request waits
// and the dialog host fulfils it when the dialog closes.
export function useFocusRequest(scope, ref) {
  const request = useStore(selectFocusRequest);
  useLayoutEffect(() => {
    if (request?.scope !== scope || state.editorDialog) return;
    focusKey(request.key, { within: ref.current });
    clearFocusRequest(request);
  }, [request]);
}
