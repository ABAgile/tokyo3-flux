// Board lookups that render helpers take explicitly. Name, label, project,
// sprint, column and participant resolution reads these maps instead of the
// store, so a memoized row that receives them re-renders exactly when the data
// it can show changes.
/** @type {readonly never[]} */
const NONE = Object.freeze([]);

function byKey(values, key) {
  return new Map((values || NONE).map((value) => [key(value), value]));
}
function groupBy(values, key) {
  const groups = new Map();
  for (const value of values || NONE) {
    const id = key(value);
    const group = groups.get(id);
    if (group) group.push(value);
    else groups.set(id, [value]);
  }
  return groups;
}
function sameInputs(left, right) {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  );
}

// Built once per change of the entity lists it indexes. A board refresh keeps
// unchanged lists by identity, so moving or editing a card keeps the same
// lookups and every row that did not change can skip rendering.
let lookupsCache;
/**
 * @param {Flux.Board | undefined} board
 * @param {Flux.Session | undefined} session
 * @returns {Flux.Lookups}
 */
export function boardLookups(board, session) {
  const inputs = [
    board?.members,
    board?.labels,
    board?.projects,
    board?.sprints,
    board?.columns,
    board?.participants,
    session,
  ];
  if (lookupsCache && sameInputs(lookupsCache.inputs, inputs)) return lookupsCache.lookups;
  const sprints = board?.sprints || NONE;
  const lookups = Object.freeze({
    session,
    membersBySubject: byKey(board?.members, (member) => member.subject),
    labelsByName: byKey(board?.labels, (label) => label.name),
    projectsById: byKey(board?.projects, (project) => project.id),
    sprintsById: byKey(sprints, (sprint) => sprint.id),
    columnsById: byKey(board?.columns, (column) => column.id),
    participantsByItem: groupBy(board?.participants, (participant) => participant.item_id),
    activeSprints: sprints.filter((sprint) => sprint.state === 'active'),
  });
  lookupsCache = { inputs, lookups };
  return lookups;
}
/** @param {Flux.State} current */
export function selectLookups(current) {
  return boardLookups(current.board, current.session);
}

// Items by id across the board payload and the loaded archive page, for
// dependency resolution. Rebuilt only when either list changes.
let itemsCache;
/**
 * @param {Flux.Board | undefined} board
 * @param {Flux.Item[]} archiveItems
 * @returns {ReadonlyMap<string, Flux.Item>}
 */
export function itemLookup(board, archiveItems) {
  const inputs = [board?.items, archiveItems];
  if (itemsCache && sameInputs(itemsCache.inputs, inputs)) return itemsCache.items;
  const items = byKey(archiveItems, (item) => item.id);
  for (const item of board?.items || NONE) items.set(item.id, item);
  itemsCache = { inputs, items };
  return items;
}
