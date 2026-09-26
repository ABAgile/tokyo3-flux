// Compare visible element paths and computed styles, not renderer bookkeeping
// or hidden retained dialogs. Inputs are the raw style-snapshot.browser results.
import { readFile } from 'node:fs/promises';

async function load(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  return typeof value === 'string' ? JSON.parse(value) : value;
}
function visible(snapshot, rows) {
  const result = new Map(),
    styles = new Map(),
    hidden = new Map();
  for (const row of rows) {
    const [path, , , key] = row.split(' | ');
    if (key && !Object.hasOwn(snapshot.styles, key))
      throw new Error(`Unknown style key at ${path}; unsupported snapshot format`);
    const parent = path.includes('>') ? path.slice(0, path.lastIndexOf('>')) : '';
    const style = { ...styles.get(parent) };
    for (const line of (snapshot.styles[key] || '').split('\n').filter(Boolean)) {
      const separator = line.indexOf(': ');
      style[line.slice(0, separator)] = line.slice(separator + 2);
    }
    styles.set(path, style);
    hidden.set(path, hidden.get(parent) || style.display === 'none');
    if (!hidden.get(path) && style.visibility !== 'hidden' && style.visibility !== 'collapse')
      result.set(path, style);
  }
  return result;
}
if (process.argv.length !== 4) {
  console.error('Usage: node tests/compare-style-snapshots.mjs BEFORE.result AFTER.result');
  process.exit(2);
}
const before = await load(process.argv[2]),
  after = await load(process.argv[3]);
const differences = [];
for (const name of new Set([...Object.keys(before.captures), ...Object.keys(after.captures)])) {
  if (!before.captures[name] || !after.captures[name]) {
    differences.push(`${name}: missing capture`);
    continue;
  }
  const a = visible(before, before.captures[name]),
    b = visible(after, after.captures[name]);
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(path) || !b.has(path)) {
      differences.push(`${name} ${path}: visible element ${a.has(path) ? 'removed' : 'added'}`);
      continue;
    }
    for (const property of new Set([...Object.keys(a.get(path)), ...Object.keys(b.get(path))])) {
      const old = a.get(path)[property],
        next = b.get(path)[property];
      if (old !== next) differences.push(`${name} ${path}: ${property}: ${old} -> ${next}`);
    }
  }
}
if (differences.length) {
  console.error(differences.slice(0, 100).join('\n'));
  console.error(`${differences.length} visible structure/style differences`);
  process.exitCode = 1;
} else
  console.log(
    `PASS: visible paths and computed styles match in ${Object.keys(before.captures).length} captures.`,
  );
