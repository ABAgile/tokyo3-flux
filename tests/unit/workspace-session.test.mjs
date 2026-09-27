// Workspace-scoped cancellation: one session signal per workspace, and board
// loads that abort their predecessor.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const modules = '../../internal/planningui/static/modules';
const { beginWorkspaceSession, withWorkspace, workspaceSignal } = await import(
  `${modules}/workspace-session.js`
);
const { beginLoad, finishLoad } = await import(`${modules}/sync.js`);
const { state } = await import(`${modules}/state.js`);

test('a new workspace session aborts the previous one', () => {
  const first = workspaceSignal();
  const owned = new AbortController();
  const combined = withWorkspace(owned.signal);
  const second = beginWorkspaceSession();
  assert.ok(first.aborted);
  assert.ok(combined.aborted, 'work owned by both stops with the session');
  assert.ok(!second.aborted);
  assert.equal(workspaceSignal(), second);
});

test('work owned by a caller also stops with the caller', () => {
  beginWorkspaceSession();
  const owned = new AbortController();
  const combined = withWorkspace(owned.signal);
  owned.abort();
  assert.ok(combined.aborted);
  assert.ok(!workspaceSignal().aborted);
});

test('a new load aborts the one in flight and only the current load ends loading', () => {
  beginWorkspaceSession();
  const first = beginLoad();
  assert.equal(state.loading, true);
  const second = beginLoad();
  assert.ok(first.signal.aborted);
  finishLoad(first);
  assert.equal(state.loading, true, 'a superseded load leaves loading to its successor');
  finishLoad(second);
  assert.equal(state.loading, false);
});

test('leaving the workspace aborts the current load, which still ends loading', () => {
  const load = beginLoad();
  beginWorkspaceSession();
  assert.ok(load.signal.aborted);
  finishLoad(load);
  assert.equal(state.loading, false);
});
