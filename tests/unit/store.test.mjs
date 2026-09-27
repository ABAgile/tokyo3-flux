// Store update and subscription semantics: setState patches, the read-only
// state view and useStore's selection equality.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, installDOM } from './dom.mjs';

const createHost = installDOM();
const modules = '../../internal/planningui/static/modules';
const { createStore } = await import(`${modules}/store.js`);
const { html, shallowEqual } = await import(`${modules}/vdom.js`);
const { render } = await import(`${modules}/vendor-preact.js`);

test('setState replaces changed top-level values and notifies once', () => {
  const list = [1];
  const store = createStore({ count: 0, list, name: 'a' });
  let notified = 0;
  store.subscribe(() => notified++);
  const before = store.getState();
  store.setState({ count: 1, list });
  assert.equal(notified, 1);
  assert.notEqual(store.getState(), before);
  assert.equal(store.getState().list, list, 'unchanged values keep their identity');
  assert.deepEqual(before, { count: 0, list, name: 'a' }, 'the previous state is not mutated');
});

test('setState ignores patches that change nothing', () => {
  const store = createStore({ count: 0, nan: Number.NaN });
  let notified = 0;
  store.subscribe(() => notified++);
  const before = store.getState();
  store.setState({ count: 0, nan: Number.NaN });
  store.setState(() => undefined);
  store.setState(undefined);
  assert.equal(notified, 0);
  assert.equal(store.getState(), before);
});

test('a function patch receives the current state', () => {
  const store = createStore({ count: 1 });
  store.setState((current) => ({ count: current.count + 1 }));
  store.setState((current) => ({ count: current.count * 10 }));
  assert.equal(store.getState().count, 20);
});

test('unsubscribe stops notifications', () => {
  const store = createStore({ count: 0 });
  let notified = 0;
  const stop = store.subscribe(() => notified++);
  store.setState({ count: 1 });
  stop();
  store.setState({ count: 2 });
  assert.equal(notified, 1);
});

test('the state view reads the current state and refuses writes', () => {
  const store = createStore({ count: 0 });
  store.setState({ count: 3 });
  assert.equal(store.state.count, 3);
  assert.ok('count' in store.state);
  assert.deepEqual(Object.keys(store.state), ['count']);
  assert.throws(() => {
    store.state.count = 4;
  }, /read-only/);
  assert.equal(store.state.count, 3);
});

test('useStore re-renders only when its selection changes', async () => {
  const store = createStore({ count: 0, other: 0 });
  let renders = 0;
  function Probe() {
    renders++;
    return html`<p>${store.useStore((current) => current.count)}</p>`;
  }
  const host = createHost();
  render(html`<${Probe} />`, host);
  await flush();
  assert.equal(host.textContent, '0');
  const initial = renders;
  store.setState({ other: 1 });
  await flush();
  assert.equal(renders, initial, 'an unrelated change does not render');
  store.setState({ count: 2 });
  await flush();
  assert.equal(host.textContent, '2');
  assert.equal(renders, initial + 1);
  render(null, host);
});

test('useStore compares object selections with the given equality', async () => {
  const store = createStore({ a: 1, b: 2, c: 3 });
  let renders = 0;
  function Probe() {
    renders++;
    const { a, b } = store.useStore((current) => ({ a: current.a, b: current.b }), shallowEqual);
    return html`<p>${a + b}</p>`;
  }
  const host = createHost();
  render(html`<${Probe} />`, host);
  await flush();
  const initial = renders;
  store.setState({ c: 4 });
  await flush();
  assert.equal(renders, initial, 'a shallow-equal selection does not render');
  store.setState({ a: 5 });
  await flush();
  assert.equal(host.textContent, '7');
  assert.equal(renders, initial + 1);
  render(null, host);
});

test('a throwing selector does not break setState for other subscribers', async () => {
  const store = createStore({ broken: false, count: 0 });
  function Broken() {
    store.useStore((current) => {
      if (current.broken) throw new Error('selector failure');
      return current.count;
    });
    return null;
  }
  let seen;
  store.subscribe(() => {
    seen = store.getState().count;
  });
  const host = createHost();
  render(html`<${Broken} />`, host);
  await flush();
  assert.doesNotThrow(() => store.setState({ broken: true, count: 1 }));
  assert.equal(seen, 1);
  render(null, host);
});
