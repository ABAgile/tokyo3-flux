// Contains a rendering failure to one part of the page. Everything renders in
// one Preact tree, so without a boundary a single exception during render
// would blank the whole page.
import { html } from './vdom.js';
import { useErrorBoundary, useLayoutEffect, useRef } from './vendor-preact.js';

/**
 * @param {string} label
 * @param {() => void} retry
 */
function defaultFallback(label, retry) {
  return html`<div class="notice-bar notice-bar-danger" role="alert" data-error-boundary="true">
    <span>${`${label} could not be shown. Retry, or reload the page if this keeps happening.`}</span>
    <button type="button" onClick=${retry}>Retry</button>
  </div>`;
}

// `label` names what failed, for example "Planning content". A changed
// `resetKey` clears the failure, so moving on (another view or record) renders
// the children again. `fallback(label, retry)` replaces the default notice.
/**
 * @param {{ label: string, resetKey?: unknown,
 *   fallback?: (label: string, retry: () => void) => unknown, children?: unknown }} props
 */
export function ErrorBoundary({ label, resetKey, fallback = defaultFallback, children }) {
  const [error, resetError] = useErrorBoundary((failure) => {
    console.error(`${label} failed to render.`, failure);
  });
  const shownKey = useRef(resetKey);
  useLayoutEffect(() => {
    if (Object.is(shownKey.current, resetKey)) return;
    shownKey.current = resetKey;
    if (error) resetError();
  }, [resetKey, error]);
  return error ? fallback(label, resetError) : children;
}
