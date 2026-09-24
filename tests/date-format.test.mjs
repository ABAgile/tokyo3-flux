import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../internal/planningui/static/modules/format.js', import.meta.url), 'utf8');
const {dueDatePresentation, formatDateOnly} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const today = new Date(2026, 2, 4, 0, 1);

assert.equal(dueDatePresentation('2026-03-03', 'todo', false, today).overdue, true);
assert.match(dueDatePresentation('2026-03-03', 'todo', false, today).label, /Overdue/);
assert.equal(dueDatePresentation('2026-03-04', 'todo', false, today).overdue, false);
assert.equal(dueDatePresentation('2026-03-03', 'done', false, today).overdue, false);
assert.equal(dueDatePresentation('2026-03-03', 'todo', true, today).overdue, false);
assert.equal(dueDatePresentation('2026-02-30', 'todo', false, today), undefined);
assert.equal(formatDateOnly('2026-02-30'), '');
assert.match(formatDateOnly('2026-03-04'), /2026/);
