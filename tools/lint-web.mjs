// Planning UI rendering guardrails, run by `make lint-web` and `make check-web`.
// Components render from the store and own their DOM through Preact; direct DOM
// lookups, listeners and state writes are confined to the modules allowed below.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../internal/planningui/static/', import.meta.url).pathname;
const files = [
  'app.js',
  ...readdirSync(join(root, 'modules'))
    .filter((name) => name.endsWith('.js') && name !== 'vendor-preact.js')
    .map((name) => `modules/${name}`),
];
// api.js owns XHR progress listeners; ui-hooks.js owns the effect-scoped
// document listeners and focus lookup; actions.js may coordinate focus.
const allowed = new Set(['modules/api.js', 'modules/actions.js', 'modules/ui-hooks.js']);
const rules = [
  [/(?<![\w$])\$\(/, 'use a ref or store state instead of $(…)'],
  [/\bdocument\.querySelector(All)?\b/, 'use a ref, a focus key or component state'],
  [/\baddEventListener\b/, 'use useEventListener, useDismiss or a Preact event prop'],
  [/\bstate\.[A-Za-z_$][\w$]*\s*(=(?!=)|\+\+|--|[-+*/]=)/, 'state is read-only; use setState'],
];
let failures = 0;
for (const file of files) {
  if (allowed.has(file)) continue;
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (/^\s*\/\//.test(line)) return;
    for (const [pattern, advice] of rules)
      if (pattern.test(line)) {
        failures++;
        console.error(`${file}:${index + 1}: ${advice}\n  ${line.trim()}`);
      }
  });
}
if (failures) {
  console.error(`lint-web: ${failures} rendering guardrail violation(s)`);
  process.exit(1);
}
console.log('lint-web: rendering guardrails ok');
