// Shared lifecycle helpers for component-owned requests and dismissal listeners.
import { useEffect, useRef, useState } from './vendor-preact.js';

// `request` receives an AbortSignal. Every captured value that should restart
// the request belongs in `dependencies`; previous data remains while reloading.
export function useRequest(request, dependencies = []) {
  const requestRef = useRef(request);
  requestRef.current = request;
  const [result, setResult] = useState({ data: undefined, error: undefined, loading: false });
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

  return { ...result, reload: () => setGeneration((value) => value + 1) };
}

// Dismiss an open component when a pointer lands outside its ref or Escape is
// pressed. The callback stays current without reinstalling document listeners.
export function useDismiss(ref, open, onDismiss) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event) => {
      const element = ref.current;
      if (element && !element.contains(event.target)) dismissRef.current?.(event);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) dismissRef.current?.(event);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, open]);
}
