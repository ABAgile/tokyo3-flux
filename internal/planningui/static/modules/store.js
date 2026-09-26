// Small Preact-aware external store for shared application state.
import { useLayoutEffect, useReducer, useRef } from './preact.js';

export function createStore(initialState) {
  const listeners = new Set();
  const store = { state: initialState };

  function publish() {
    listeners.forEach((listener) => {
      listener();
    });
  }

  function setState(update) {
    const patch = typeof update === 'function' ? update(store.state) : update;
    if (!patch || typeof patch !== 'object') return;
    const entries = Object.entries(patch).filter(
      ([key, value]) => !Object.is(store.state[key], value),
    );
    if (!entries.length) return;
    store.state = { ...store.state, ...Object.fromEntries(entries) };
    publish();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function useStore(selector, equal = Object.is) {
    const selectorRef = useRef(selector);
    selectorRef.current = selector;
    const equalRef = useRef(equal);
    equalRef.current = equal;
    const selectedRef = useRef(selector(store.state));
    const [, forceRender] = useReducer((value) => value + 1, 0);

    useLayoutEffect(() => {
      const update = () => {
        const next = selectorRef.current(store.state);
        if (equalRef.current(selectedRef.current, next)) return;
        selectedRef.current = next;
        forceRender();
      };
      const unsubscribe = subscribe(update);
      update();
      return unsubscribe;
    }, []);

    const selected = selectorRef.current(store.state);
    if (!equalRef.current(selectedRef.current, selected)) selectedRef.current = selected;
    return selected;
  }

  // Compatibility view for existing controllers while they migrate to patches.
  const state = new Proxy(initialState, {
    get(_target, property) {
      return store.state[property];
    },
    set(_target, property, value) {
      setState({ [property]: value });
      return true;
    },
    deleteProperty(_target, property) {
      if (!Object.hasOwn(store.state, property)) return true;
      const next = { ...store.state };
      delete next[property];
      store.state = next;
      publish();
      return true;
    },
    ownKeys() {
      return Reflect.ownKeys(store.state);
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Object.getOwnPropertyDescriptor(store.state, property);
      return descriptor && { ...descriptor, configurable: true };
    },
  });

  return { state, setState, useStore };
}
