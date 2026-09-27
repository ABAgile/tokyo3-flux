// Shared lifecycle helpers: component-owned requests, mutations, outside
// listeners and focus. Document and window listeners live only in these effects.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from './vendor-preact.js';

// `request` receives an AbortSignal. Every captured value that should restart
// the request belongs in `dependencies`; previous data remains while reloading.
/**
 * @template T
 * @param {(signal: AbortSignal) => T | Promise<T>} request
 * @param {unknown[]} [dependencies]
 */
export function useRequest(request, dependencies = []) {
  const requestRef = useRef(request);
  requestRef.current = request;
  /** @type {{ data: T | undefined, error: any, loading: boolean }} */
  const initial = { data: undefined, error: undefined, loading: false };
  const [result, setResult] = useState(initial);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult((current) => ({ ...current, error: undefined, loading: true }));
    Promise.resolve()
      .then(() => requestRef.current(controller.signal))
      .then((data) => {
        if (active && !controller.signal.aborted)
          setResult({ data, error: undefined, loading: false });
      })
      .catch((error) => {
        if (active && !controller.signal.aborted)
          setResult((current) => ({ ...current, error, loading: false }));
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [...dependencies, generation]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { ...result, reload };
}

// Resolves once `ready()` holds, re-checking on every `subscribe` notification;
// rejects with an AbortError when `signal` aborts first.
export function waitUntil(subscribe, ready, signal) {
  if (ready()) return Promise.resolve();
  /** @type {Promise<void>} */
  const settled = new Promise((resolve, reject) => {
    const stop = subscribe(() => {
      if (!ready()) return;
      stop();
      signal.removeEventListener('abort', abort);
      resolve();
    });
    const abort = () => {
      stop();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  return settled;
}

// Writes owned by a component: one at a time, each with an AbortSignal that is
// aborted when the component unmounts. `run` returns undefined when a write is
// already pending, which guards against double submission.
export function useMutation() {
  const controllers = useRef(new Set());
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  useEffect(
    () => () => {
      controllers.current.forEach((controller) => {
        controller.abort();
      });
    },
    [],
  );
  const run = useCallback(async (task) => {
    if (running.current) return undefined;
    running.current = true;
    const controller = new AbortController();
    controllers.current.add(controller);
    setPending(true);
    try {
      return await task(controller.signal);
    } finally {
      controllers.current.delete(controller);
      running.current = false;
      if (!controller.signal.aborted) setPending(false);
    }
  }, []);
  return { run, pending };
}

// Dismiss an open component when a pointer lands outside its ref or Escape is
// pressed. The callback stays current without reinstalling document listeners.
export function useDismiss(
  ref,
  open,
  onDismiss,
  { closeOnEscape = true, event = 'pointerdown' } = {},
) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return undefined;

    const onPointer = (pointer) => {
      const element = ref.current;
      if (element && !element.contains(pointer.target)) dismissRef.current?.(pointer);
    };
    const onKeyDown = (key) => {
      if (key.key === 'Escape' && !key.defaultPrevented) dismissRef.current?.(key);
    };
    document.addEventListener(event, onPointer);
    if (closeOnEscape) document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener(event, onPointer);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, open, closeOnEscape, event]);
}

// A document or window listener for the lifetime of the component, optionally
// only while `active`. The handler stays current without reinstalling.
export function useEventListener(target, type, handler, { active = true, capture = false } = {}) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!active || !target) return undefined;
    const listener = (event) => handlerRef.current(event);
    target.addEventListener(type, listener, capture);
    return () => target.removeEventListener(type, listener, capture);
  }, [target, type, active, capture]);
}

// Calls `onChange` after a changed value has been committed to the DOM, so
// form readers see the rendered controls. The first render does not report.
export function useCommittedChange(value, onChange) {
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const previous = useRef(value);
  useLayoutEffect(() => {
    if (Object.is(previous.current, value)) return;
    previous.current = value;
    changeRef.current?.(value);
  }, [value]);
}

export function useDebouncedValue(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (!delay) {
      setDebounced(value);
      return undefined;
    }
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return delay ? debounced : value;
}

function focusKeyTarget(root, key) {
  return root.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
}

// Moves focus to the control with a logical focus key inside `within`. Call it
// from a layout effect of the component that rendered the control, so the
// render that shows it has committed. `onlyIfLost` leaves focus alone when it
// already moved on. Returns whether the request is settled.
export function focusKey(key, { within = document, onlyIfLost = false } = {}) {
  if (!key) return false;
  const active = document.activeElement;
  if (onlyIfLost && active && active !== document.body) return true;
  const target = within && focusKeyTarget(within, key);
  if (!target || target.disabled) return false;
  target.focus({ preventScroll: true });
  return true;
}

// One focus-restore effect for keyed content whose element can be recreated,
// such as a card that moves between columns. Spread `handlers` on the container.
export function useFocusRestore(ref, route) {
  const focusKey = useRef('');
  const previousRoute = useRef(route);
  if (previousRoute.current !== route) {
    focusKey.current = '';
    previousRoute.current = route;
  }
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container || !focusKey.current || document.activeElement !== document.body) return;
    focusKeyTarget(container, focusKey.current)?.focus({ preventScroll: true });
  });
  const record = useCallback((event) => {
    focusKey.current = event.target.closest?.('[data-focus-key]')?.dataset.focusKey || '';
  }, []);
  const clearOutside = useCallback((event) => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
      focusKey.current = '';
  }, []);
  return {
    onFocusCapture: record,
    onPointerDownCapture: record,
    onBlurCapture: clearOutside,
  };
}
