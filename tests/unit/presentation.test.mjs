// Pure presentation, permissions, selection and event logic using a board
// serialized by Go. No network, timers or browser instance are needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { installDOM } from './dom.mjs';
import { render } from '../../internal/planningui/static/modules/vendor-preact.js';
import { boardLookups } from '../../internal/planningui/static/modules/lookups.js';
import {
  itemDateStatus,
  dueDateBadgeTemplate,
} from '../../internal/planningui/static/modules/due-dates.js';
import {
  canWrite,
  writable,
  adminWritable,
  gitLabWritable,
  canComment,
} from '../../internal/planningui/static/modules/permissions.js';
import { getState, setState } from '../../internal/planningui/static/modules/state.js';
import {
  memberInfo,
  memberListingInfo,
  participantStackTemplate,
} from '../../internal/planningui/static/modules/people.js';
import {
  initials,
  attachmentSize,
  attachmentKind,
  attachmentTypeDescription,
  labelForeground,
  workspaceHistoryLabel,
  columnWIPLabel,
} from '../../internal/planningui/static/modules/format.js';
import { mergeEventProps } from '../../internal/planningui/static/modules/drag.js';
import { prunedBulkSelection } from '../../internal/planningui/static/modules/bulk.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/board.json', import.meta.url), 'utf8'),
);
const root = installDOM();
const session = { subject: '7', name: 'Session member', avatar_url: '/session.png', csrf: '' };
function board(extra = {}) {
  return { ...structuredClone(fixture), ...extra };
}
function nodes(node) {
  return [node, ...node.childNodes.flatMap(nodes)];
}
function rendered(template) {
  const container = root();
  render(template, container);
  return container;
}

test('Go board fixture has usable entity lookups and no private attachment metadata', () => {
  const lookups = boardLookups(fixture, session);
  assert.equal(lookups.membersBySubject.get('7').name, 'Team member');
  assert.equal(lookups.projectsById.get('project-one').workspace_id, fixture.workspace.id);
  assert.equal(fixture.links[0].observation.pipeline.current_head, true);
  assert.equal(fixture.items[0].attachments[0].storage_key, undefined);
  assert.equal(fixture.items[0].attachments[0].cleanup_queued, undefined);
});

test('due-date status resolves column lifecycle, archived work and absent dates', () => {
  const current = board();
  const lookups = boardLookups(current, session);
  const item = { ...current.items[0], due_date: '2026-09-10' };
  const now = new Date(2026, 8, 12, 12);
  assert.equal(itemDateStatus(lookups, item, now).overdue, true);
  assert.equal(itemDateStatus(lookups, { ...item, archived: true }, now).overdue, false);
  assert.equal(itemDateStatus(lookups, { ...item, due_date: '2026-09-12' }, now).overdue, false);
  assert.equal(itemDateStatus(lookups, { ...item, due_date: 'invalid' }, now), undefined);
  const done = board({ columns: [{ ...current.columns[0], category: 'done' }] });
  assert.equal(itemDateStatus(boardLookups(done, session), item, now).overdue, false);
});

test('due badges carry item identity and lifecycle attributes, and disappear without a date', () => {
  const current = board();
  const lookups = boardLookups(current, session);
  const item = { ...current.items[0], due_date: '2026-09-10' };
  const span = rendered(
    dueDateBadgeTemplate(lookups, item, new Date(2026, 8, 12), ' title-date', 'due-one'),
  ).firstChild;
  assert.equal(span.attributes.id, 'due-one');
  assert.equal(span.attributes['data-due-date-badge'], item.id);
  assert.equal(span.attributes['data-due-category'], 'todo');
  assert.equal(span.attributes['data-due-archived'], 'false');
  assert.ok(span.attributes.class.includes('is-overdue'));
  assert.equal(dueDateBadgeTemplate(lookups, { ...item, due_date: '' }), null);
});

test('permission selectors respect role, missing boards, loading and in-flight writes', () => {
  for (const role of ['viewer', 'member', 'admin']) {
    const current = board({ role });
    assert.equal(canWrite({ board: current, busy: false, loading: false }), role !== 'viewer');
    assert.equal(canWrite({ board: current, busy: true, loading: false }), false);
    assert.equal(canWrite({ board: current, busy: false, loading: true }), false);
  }
  assert.equal(canWrite({ board: undefined, busy: false, loading: false }), false);
});

test('event-time permissions require matching GitLab approval and retain member/admin restrictions', () => {
  const previous = getState();
  try {
    setState({ board: board(), busy: false, loading: false });
    assert.ok(writable() && adminWritable() && gitLabWritable() && canComment());
    setState({ board: board({ role: 'member' }) });
    assert.ok(writable() && gitLabWritable() && canComment());
    assert.equal(adminWritable(), false);
    setState({
      board: board({ integration: { instance: 'https://other.example', projects: [42] } }),
    });
    assert.equal(gitLabWritable(), false);
    setState({
      board: board({ integration: { instance: fixture.connector_instance, projects: [] } }),
    });
    assert.equal(gitLabWritable(), false);
    setState({ board: board({ role: 'viewer' }) });
    assert.ok(!writable() && !adminWritable() && !gitLabWritable() && !canComment());
    setState({ board: board(), loading: true });
    assert.ok(!writable() && !adminWritable() && !gitLabWritable() && !canComment());
  } finally {
    setState(previous);
  }
});

test('member presentation resolves workspace identity before session and safe fallbacks', () => {
  const lookups = boardLookups(fixture, session);
  assert.deepEqual(memberInfo(lookups, '7'), {
    name: 'Team member',
    avatarURL: fixture.members[0].avatar_url,
  });
  assert.deepEqual(memberInfo(lookups, ''), { name: 'Unassigned', avatarURL: '' });
  assert.equal(memberInfo(lookups, 'unknown').name, 'Unnamed member (unknown)');
  assert.equal(memberInfo(boardLookups(board({ members: [] }), session), '7').name, session.name);
  assert.equal(
    memberListingInfo({ subject: 'other', name: '  ', username: 'provider' }, session).name,
    'provider',
  );
  assert.equal(
    memberListingInfo({ subject: 'other', name: '', username: '' }, session).name,
    'Unnamed member',
  );
});

test('participant stack uses workspace names and reports role/overflow accessibly', () => {
  const participants = Array.from({ length: 6 }, (_, index) => ({
    item_id: fixture.items[0].id,
    subject: String(index + 7),
    name: `Provider ${index}`,
    roles: index === 0 ? ['assignee', 'commenter'] : ['reviewer'],
  }));
  const lookups = boardLookups(board({ participants }), session);
  const container = rendered(participantStackTemplate(lookups, fixture.items[0]));
  const stack = container.firstChild;
  assert.ok(stack.attributes['aria-label'].includes('Team member · Assignee, Commenter'));
  assert.ok(!stack.attributes['aria-label'].includes('Provider 0'));
  assert.equal(
    nodes(container).filter((node) => node.attributes.class?.includes('participant-avatar')).length,
    4,
  );
  const overflow = nodes(container).find((node) => node.attributes.class === 'participant-more');
  assert.equal(overflow.textContent, '+2');
  assert.ok(overflow.attributes['aria-label'].includes('Provider 5'));
  assert.equal(
    nodes(container).filter((node) => node.attributes['data-participant-role'] === 'assignee')
      .length,
    1,
  );
});

test('empty participant stacks remain explicit', () => {
  const container = rendered(
    participantStackTemplate(boardLookups(board({ participants: [] }), session), fixture.items[0]),
  );
  assert.equal(container.textContent, 'Unassigned');
  assert.equal(container.firstChild.attributes['aria-label'], 'No participants · unassigned');
});

test('formatting handles Unicode names, byte boundaries and invalid values', () => {
  for (const [name, expected] of [
    ['', '—'],
    ['  alex  example reviewer ', 'AE'],
    ['😀 Smith', '😀S'],
  ]) {
    assert.equal(initials(name), expected);
  }
  for (const [size, expected] of [
    [-1, 'unknown size'],
    [NaN, 'unknown size'],
    [Infinity, 'unknown size'],
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KiB'],
    [1536, '1.5 KiB'],
    [1024 ** 2, '1 MiB'],
    [1024 ** 3, '1 GiB'],
  ]) {
    assert.equal(attachmentSize(size), expected);
  }
});

test('attachment descriptions, label contrast and planning captions stay semantic', () => {
  assert.equal(attachmentKind({ content_type: 'image/png', name: 'bad.exe' }), 'IMG');
  assert.equal(attachmentKind({ content_type: 'application/pdf' }), 'PDF');
  assert.equal(attachmentKind({ name: 'notes.txt' }), 'TXT');
  assert.equal(attachmentKind({}), 'FILE');
  assert.equal(
    attachmentTypeDescription({ content_type: 'application/pdf' }),
    'PDF file · application/pdf',
  );
  assert.equal(labelForeground('#ffffff'), 'var(--label-ink)');
  assert.equal(labelForeground('#000000'), 'var(--label-contrast)');
  assert.equal(labelForeground('red'), 'var(--ink)');
  assert.equal(workspaceHistoryLabel(fixture.workspace), 'Contract team (workspace-one)');
  assert.equal(columnWIPLabel({ wip: 0 }, 7), 'No limit');
  assert.equal(columnWIPLabel({ wip: 5 }, 2), '2/5 WIP');
});

test('mergeEventProps composes handlers in order without mutating inputs', () => {
  const calls = [];
  const event = {};
  const first = {
    onClick: (value) => {
      assert.equal(value, event);
      calls.push('first');
    },
  };
  const second = { onClick: () => calls.push('second'), onDragOver: () => calls.push('drag') };
  const merged = mergeEventProps(first, second);
  merged.onClick(event);
  merged.onDragOver(event);
  assert.deepEqual(calls, ['first', 'second', 'drag']);
  assert.equal(first.onDragOver, undefined);
  assert.notEqual(merged.onClick, first.onClick);
  assert.deepEqual(mergeEventProps(), {});
});

test('bulk selection keeps identity when valid and drops hidden, missing and archived cards', () => {
  const selection = ['a', 'b'];
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'archived', archived: true }];
  assert.equal(prunedBulkSelection(selection, items), selection);
  const stale = ['gone', 'b', 'archived', 'a'];
  assert.deepEqual(prunedBulkSelection(stale, items), ['b', 'a']);
  assert.deepEqual(stale, ['gone', 'b', 'archived', 'a']);
  assert.deepEqual(prunedBulkSelection(selection, []), []);
});
