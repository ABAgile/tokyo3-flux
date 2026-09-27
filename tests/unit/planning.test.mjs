// Pure planning logic: filter rules, optimistic placement and undo, board
// merging, planning URL restore, selection toggling and board lookups.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const modules = '../../internal/planningui/static/modules';
const { withFilterValue, matchesFilter, knownFilters } = await import(`${modules}/filters.js`);
const { optimisticPatch, undoableInverse } = await import(`${modules}/commands.js`);
const { mergeBoardData } = await import(`${modules}/sync.js`);
const { planningPatchFromURL } = await import(`${modules}/url-state.js`);
const { toggled } = await import(`${modules}/actions.js`);
const { boardLookups, itemLookup } = await import(`${modules}/lookups.js`);
const { blocked, done } = await import(`${modules}/items.js`);

function item(id, extra = {}) {
  return {
    id,
    title: `Item ${id}`,
    description: '',
    start_date: '',
    end_date: '',
    due_date: '',
    column_id: 'todo',
    project_id: '',
    project_ids: [],
    sprint_ids: [],
    assignee: '',
    labels: [],
    dependencies: [],
    ...extra,
  };
}
function board(extra = {}) {
  return {
    workspace: { id: 'w', name: 'W', role: 'admin', revision: 1 },
    role: 'admin',
    connector_instance: '',
    integration: { instance: '', projects: [] },
    projects: [{ id: 'p1', name: 'Project one' }],
    columns: [
      { id: 'todo', name: 'To do', category: 'todo', wip: 0 },
      { id: 'done', name: 'Done', category: 'done', wip: 0 },
    ],
    items: [item('a'), item('b'), item('c')],
    sprints: [{ id: 's1', name: 'Sprint', goal: '', start: '', end: '', state: 'active' }],
    labels: [{ name: 'bug', color: '#ffcc00' }],
    members: [{ subject: 'm1', name: 'Member', role: 'member' }],
    links: [],
    participants: [],
    closed_scope: [],
    ...extra,
  };
}
function state(extra = {}) {
  return { board: board(), archiveItems: [], ...extra };
}

// ── Filter rules ────────────────────────────────────────────────────────────

test('withFilterValue adds values, keeps none exclusive and all clears', () => {
  assert.deepEqual(withFilterValue([], 'p1'), ['p1']);
  assert.deepEqual(withFilterValue(['p1'], 'p2'), ['p1', 'p2']);
  assert.deepEqual(withFilterValue(['p1', 'p2'], 'p1'), ['p2', 'p1'], 'a repeat moves to the end');
  assert.deepEqual(withFilterValue(['p1'], 'none'), ['none']);
  assert.deepEqual(withFilterValue(['none'], 'p1'), ['p1']);
  assert.deepEqual(withFilterValue(['p1'], 'all'), []);
  assert.deepEqual(withFilterValue(['p1'], ''), []);
});

test('matchesFilter treats empty as all and none as no association', () => {
  assert.ok(matchesFilter([], []));
  assert.ok(matchesFilter([], ['p1']));
  assert.ok(matchesFilter(['none'], []));
  assert.ok(!matchesFilter(['none'], ['p1']));
  assert.ok(matchesFilter(['p1', 'p2'], ['p2']));
  assert.ok(!matchesFilter(['p1'], ['p2']));
});

test('knownFilters drops values the board no longer has and keeps identity otherwise', () => {
  const current = board();
  const kept = { project: ['p1', 'none'], assignee: ['m1'], label: ['bug'] };
  assert.equal(knownFilters(kept, current), kept);
  assert.deepEqual(
    knownFilters({ project: ['p1', 'gone'], assignee: ['left'], label: ['bug', 'old'] }, current),
    { project: ['p1'], assignee: [], label: ['bug'] },
  );
});

// ── Optimistic placement and undo ───────────────────────────────────────────

test('optimisticPatch moves a card before its anchor and re-ranks the board', () => {
  const current = state();
  const patch = optimisticPatch(current, {
    kind: 'item.move',
    target: 'c',
    destination: 'done',
    before: 'a',
  });
  const items = patch.board.items;
  assert.deepEqual(
    items.map((value) => value.id),
    ['c', 'a', 'b'],
  );
  assert.equal(items[0].column_id, 'done');
  assert.deepEqual(
    items.map((value) => value.rank),
    [0, 1, 2],
  );
  assert.equal(current.board.items[2].column_id, 'todo', 'the current board is not mutated');
});

test('optimisticPatch appends without an anchor and refuses unknown targets', () => {
  const current = state();
  const end = optimisticPatch(current, { kind: 'item.rank', target: 'a' });
  assert.deepEqual(
    end.board.items.map((value) => value.id),
    ['b', 'c', 'a'],
  );
  assert.equal(
    optimisticPatch(current, { kind: 'item.move', target: 'x', destination: 'done' }),
    undefined,
  );
  assert.equal(
    optimisticPatch(current, { kind: 'item.move', target: 'a', destination: 'x' }),
    undefined,
  );
  assert.equal(
    optimisticPatch(current, { kind: 'item.rank', target: 'a', before: 'x' }),
    undefined,
  );
  assert.equal(optimisticPatch(current, { kind: 'item.update', target: 'a' }), undefined);
});

test('optimisticPatch archives from the board and restores from the archive', () => {
  const current = state({ archiveItems: [item('z', { archived: true })] });
  assert.deepEqual(
    optimisticPatch(current, { kind: 'item.archive', target: 'b' }).board.items.map((v) => v.id),
    ['a', 'c'],
  );
  assert.deepEqual(optimisticPatch(current, { kind: 'item.restore', target: 'z' }), {
    archiveItems: [],
  });
  assert.equal(optimisticPatch(current, { kind: 'item.restore', target: 'a' }), undefined);
});

test('undoableInverse moves a card back in front of its current successor', () => {
  const inverse = undoableInverse(state(), { kind: 'item.move', target: 'a', destination: 'done' });
  assert.equal(inverse.text, 'Moved “Item a”');
  assert.deepEqual(inverse.commands, [
    { kind: 'item.move', target: 'a', destination: 'todo', before: 'b' },
  ]);
  const last = undoableInverse(state(), { kind: 'item.rank', target: 'c' });
  assert.equal(last.commands[0].before, '', 'the last card returns to the end');
});

test('undoableInverse restores archived sprints and re-archives restored work', () => {
  const current = state({
    board: board({ items: [item('a', { sprint_ids: ['s1'] })] }),
    archiveItems: [item('z', { archived: true })],
  });
  assert.deepEqual(undoableInverse(current, { kind: 'item.archive', target: 'a' }).commands, [
    { kind: 'item.restore', target: 'a', restore_sprint_ids: ['s1'] },
  ]);
  const restore = undoableInverse(current, { kind: 'item.restore', target: 'z' });
  assert.equal(restore.text, 'Restored “Item z”');
  assert.deepEqual(restore.commands, [{ kind: 'item.archive', target: 'z' }]);
  assert.equal(undoableInverse(current, { kind: 'label.delete', target: 'bug' }), undefined);
});

// ── Board merging ───────────────────────────────────────────────────────────

test('mergeBoardData keeps unchanged entities and lists by identity', () => {
  const previous = board();
  const next = structuredClone(previous);
  next.workspace.revision = 2;
  next.items[1].title = 'Renamed';
  const merged = mergeBoardData(previous, next);
  assert.equal(merged.workspace.revision, 2);
  assert.equal(merged.items[0], previous.items[0]);
  assert.notEqual(merged.items[1], previous.items[1]);
  assert.equal(merged.items[1].title, 'Renamed');
  assert.notEqual(merged.items, previous.items);
  assert.equal(merged.columns, previous.columns, 'an unchanged list keeps its identity');
  assert.equal(merged.participants, previous.participants);
  assert.equal(mergeBoardData(undefined, next), next);
});

test('mergeBoardData replaces a reordered list but keeps its entities', () => {
  const previous = board();
  const next = structuredClone(previous);
  next.items.reverse();
  const merged = mergeBoardData(previous, next);
  assert.notEqual(merged.items, previous.items);
  assert.equal(merged.items[0], previous.items[2]);
});

// ── Planning URL restore ────────────────────────────────────────────────────

test('planningPatchFromURL applies known filters, mode and scope', () => {
  const patch = planningPatchFromURL(
    { mode: 'board', project: 'p1,gone', assignee: 'none', label: 'all', scope: 's1', item: 'a' },
    board(),
  );
  assert.deepEqual(patch.filters, { project: ['p1'], assignee: ['none'], label: [] });
  assert.equal(patch.presentation, 'board');
  assert.equal(patch.scope, 's1');
  assert.equal(patch.sharedItemID, 'a');
  assert.equal(patch.planningURLReady, true);
});

test('planningPatchFromURL opens a single project as a List lens over all work', () => {
  const patch = planningPatchFromURL({ project: 'p1' }, board());
  assert.equal(patch.presentation, 'list');
  assert.equal(patch.scope, 'all');
  const unknown = planningPatchFromURL({ scope: 'missing' }, board());
  assert.equal(unknown.presentation, 'board');
  assert.equal(unknown.scope, 'active');
  assert.equal(unknown.sharedItemID, '');
});

// ── Selection toggling ──────────────────────────────────────────────────────

test('toggled returns a new selection with the id flipped', () => {
  const selection = ['a'];
  const added = toggled(selection, 'b');
  assert.deepEqual(added, ['a', 'b']);
  assert.deepEqual(toggled(added, 'a'), ['b']);
  assert.deepEqual(selection, ['a'], 'the previous selection is not mutated');
});

// ── Board lookups ───────────────────────────────────────────────────────────

test('boardLookups indexes the board and keeps identity until a list changes', () => {
  const current = board({
    participants: [
      { item_id: 'a', subject: 'm1', roles: ['assignee'] },
      { item_id: 'a', subject: 'r1', roles: ['reviewer'] },
    ],
  });
  const session = { subject: 'm1', name: 'Me', avatar_url: '', csrf: '' };
  const lookups = boardLookups(current, session);
  assert.equal(lookups.projectsById.get('p1').name, 'Project one');
  assert.equal(lookups.participantsByItem.get('a').length, 2);
  assert.deepEqual(
    lookups.activeSprints.map((sprint) => sprint.id),
    ['s1'],
  );
  const moved = { ...current, items: [...current.items].reverse() };
  assert.equal(boardLookups(moved, session), lookups, 'moving cards keeps the lookups');
  const renamed = { ...current, labels: [{ name: 'bug', color: '#000000' }] };
  assert.notEqual(boardLookups(renamed, session), lookups);
});

test('blocked follows unfinished dependencies across the board and archive', () => {
  const current = board({
    items: [
      item('a', { dependencies: ['b'] }),
      item('b'),
      item('c', { dependencies: ['z'] }),
      item('d', { dependencies: ['e'] }),
      item('e', { column_id: 'done' }),
    ],
  });
  const archive = [item('z', { archived: true })];
  const lookups = boardLookups(current, undefined);
  const items = itemLookup(current, archive);
  assert.ok(blocked(lookups, items, current.items[0]));
  assert.ok(blocked(lookups, items, current.items[2]), 'an archived dependency still blocks');
  assert.ok(!blocked(lookups, items, current.items[3]), 'a done dependency does not block');
  assert.ok(done(lookups, current.items[4]));
});
