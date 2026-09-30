// Types for the exports of the generated vendor-preact.js, for the type check
// in `make check-web` only; never served. Mirrors preact/hooks' signatures for
// the runtime subset tools/vendor/preact.entry.js exports.
export type VNode = { type: unknown; props: Record<string, unknown>; key?: unknown };
export type ComponentChildren = unknown;
export type Ref<T> = { current: T };

// `key` is accepted by every element but is not a component prop.
export type Attributes = { key?: unknown };
export type FunctionComponent<P> = (props: P) => ComponentChildren;
export type ComponentType<P> = FunctionComponent<P> | (new (props: P) => Component<P, any>);
// A component's props are checked against its declared props, as in preact's
// own typings; HTM templates are not, so shared widgets are called through `h`.
export function h(
  type: string,
  props?: Record<string, unknown> | null,
  ...children: ComponentChildren[]
): VNode;
export function h<P>(
  type: ComponentType<P>,
  props: (Attributes & P) | null,
  ...children: ComponentChildren[]
): VNode;
export const Fragment: (props: { children?: ComponentChildren }) => ComponentChildren;
export class Component<P = Record<string, unknown>, S = Record<string, unknown>> {
  constructor(props?: P);
  props: P;
  state: S;
  static displayName?: string;
  setState(update: Partial<S> | ((state: S, props: P) => Partial<S> | null)): void;
  forceUpdate(): void;
  shouldComponentUpdate?(nextProps: P, nextState: S): boolean;
  render(props?: P, state?: S): ComponentChildren;
}
export interface Context<T> {
  Provider: (props: { value: T; children?: ComponentChildren }) => ComponentChildren;
}
export function createContext<T>(defaultValue: T): Context<T>;
export const options: Record<string, unknown> & {
  debounceRendering?: (callback: () => void) => void;
};
export function render(vnode: ComponentChildren, parent: Element | DocumentFragment): void;
export function htm(
  // Any hyperscript function: `never` parameters accept `h`'s overloads.
  this: (type: never, props: never, ...children: never[]) => unknown,
  strings: TemplateStringsArray,
  ...values: unknown[]
): any;

type Inputs = ReadonlyArray<unknown>;
type EffectCallback = () => void | (() => void);
export function useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void];
// Without an initial value the state and ref are assigned later, so they stay
// untyped rather than fixed to `undefined`.
export function useState(): [any, (next: any) => void];
export function useReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initial: S,
): [S, (action?: A) => void];
export function useReducer<S, A, I>(
  reducer: (state: S, action: A) => S,
  initial: I,
  init: (initial: I) => S,
): [S, (action?: A) => void];
export function useRef<T>(initial: T): Ref<T>;
export function useRef(): Ref<any>;
export function useEffect(effect: EffectCallback, inputs?: Inputs): void;
export function useLayoutEffect(effect: EffectCallback, inputs?: Inputs): void;
export function useCallback<T extends Function>(callback: T, inputs: Inputs): T;
export function useMemo<T>(factory: () => T, inputs: Inputs | undefined): T;
export function useContext<T>(context: Context<T>): T;
export function useId(): string;
export function useErrorBoundary(
  callback?: (error: any, errorInfo: { componentStack?: string }) => Promise<void> | void,
): [any, () => void];
