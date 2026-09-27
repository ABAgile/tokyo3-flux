// `options` is not used by the application; tests/board-perf.browser.js takes
// over `options.debounceRendering` to time Preact's render batch synchronously.
export { h, Fragment, Component, createContext, options, render } from 'preact';
export {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useReducer,
  useMemo,
  useErrorBoundary,
  useId,
} from 'preact/hooks';
export { default as htm } from 'htm';
