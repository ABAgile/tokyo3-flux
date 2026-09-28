// Small Preact-aware external store for shared application state.
import { useLayoutEffect, useReducer, useRef } from './vendor-preact.js';

const UNSET = Symbol('unset');

/**
 * @param {object} value
 * @param {PropertyKey} key
 */
function field(value, key) {
  return /** @type {Record<PropertyKey, unknown>} */ (value)[key];
}

/**
 * @template {object} S
 * @param {S} initialState
 */
export function createStore(initialState) {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  let current = initialState;

  /** @returns {S} */
  function getState() {
    return current;
  }

  // Every change is one top-level patch. Values are replaced, never mutated, so
  // subscribers compare selections by identity.
  /** @param {Flux.Patch<S>} update */
  function setState(update) {
    const patch = typeof update === 'function' ? update(current) : update;
    if (!patch || typeof patch !== 'object') return;
    /** @type {Record<string, unknown> | undefined} */
    let next;
    for (const [key, value] of Object.entries(patch)) {
      if (Object.is(field(current, key), value)) continue;
      next ||= { .../** @type {Record<string, unknown>} */ (current) };
      next[key] = value;
    }
    if (!next) return;
    current = /** @type {S} */ (next);
    listeners.forEach((listener) => {
      listener();
    });
  }

  /** @param {() => void} listener */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * @template T
   * @param {(current: S) => T} selector
   * @param {(left: T, right: T) => boolean} [equal]
   * @returns {T}
   */
  function useStore(selector, equal = Object.is) {
    const selectorRef = useRef(selector);
    selectorRef.current = selector;
    const equalRef = useRef(equal);
    equalRef.current = equal;
    /** @type {{ current: T | typeof UNSET }} */
    const selectedRef = useRef(UNSET);
    const [, forceRender] = useReducer((value) => value + 1, 0);

    useLayoutEffect(() => {
      const update = () => {
        let next;
        try {
          next = selectorRef.current(current);
        } catch {
          // Re-select during render, where the error reaches the nearest
          // error boundary, instead of breaking this setState for everyone.
          selectedRef.current = UNSET;
          forceRender();
          return;
        }
        if (selectedRef.current !== UNSET && equalRef.current(selectedRef.current, next)) return;
        selectedRef.current = next;
        forceRender();
      };
      const unsubscribe = subscribe(update);
      update();
      return unsubscribe;
    }, []);

    const selected = selectorRef.current(current);
    if (selectedRef.current === UNSET || !equalRef.current(selectedRef.current, selected))
      selectedRef.current = selected;
    return /** @type {T} */ (selectedRef.current);
  }

  // Read-only view for controllers and event handlers. Writes go through setState.
  /** @type {Readonly<S>} */
  const state = new Proxy(/** @type {S} */ ({}), {
    get(_target, property) {
      return field(current, property);
    },
    set(_target, property) {
      throw new TypeError(`state.${String(property)} is read-only; use setState.`);
    },
    has(_target, property) {
      return property in current;
    },
    ownKeys() {
      return Reflect.ownKeys(current);
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Object.getOwnPropertyDescriptor(current, property);
      return descriptor && { ...descriptor, configurable: true, writable: false };
    },
  });

  return { state, getState, setState, subscribe, useStore };
}
