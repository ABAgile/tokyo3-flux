// Planning changes: posting, optimistic apply, undo and sequences.
import { api, errorMessage, requestKey } from './api.js';
import { state, setState, requireBoard, sessionCSRF } from './state.js';
import { writable } from './permissions.js';
import { notice, offerUndo, UNDO_TTL } from './notices.js';
import { findItem } from './items.js';
import { refresh } from './sync.js';

// minimal skips the committed board in the receipt. A batch only needs the
// board once, so every command but the last asks for a minimal receipt and the
// whole sequence costs one board read instead of one per command.
/**
 * @param {Flux.Command} command
 * @param {string} [key]
 * @param {boolean} [minimal]
 */
function postChange(command, key = requestKey(), minimal = false) {
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': sessionCSRF(),
    'Idempotency-Key': key,
  };
  if (minimal) headers.Prefer = 'return=minimal';
  return api(`${state.root}/changes`, { method: 'POST', headers, body: JSON.stringify(command) });
}
/**
 * @param {Flux.ChangeReceipt | null | undefined} receipt
 * @returns {{ board: Flux.Board, etag: string } | undefined}
 */
function preloadedBoard(receipt) {
  return receipt?.board && typeof receipt.board_etag === 'string' && receipt.board_etag
    ? { board: receipt.board, etag: receipt.board_etag }
    : undefined;
}
// The receipt board is read after the commit, so a concurrent change can carry
// it past the revision this command produced. Its own revision is the one the
// next command in a batch must present, or the batch conflicts on a value the
// server has already moved beyond.
/**
 * @param {Flux.ChangeReceipt | null | undefined} receipt
 * @param {number} fallback
 */
export function receiptRevision(receipt, fallback) {
  const board = preloadedBoard(receipt)?.board.workspace?.revision;
  if (board !== undefined && Number.isSafeInteger(board)) return board;
  const revision = receipt?.revision;
  return revision !== undefined && Number.isSafeInteger(revision) ? revision : fallback;
}
/**
 * @param {Flux.Command} command
 * @param {string} [key]
 * @returns {Promise<{ receipt: any, refreshed: boolean }>}
 */
export async function change(command, key = requestKey()) {
  if (!writable()) throw new Error('Planning is read-only or a request is in progress.');
  setState({ busy: true });
  notice('Saving changes…');
  let receipt;
  try {
    receipt = await postChange(command, key);
  } catch (error) {
    // The save is over; callers report the failure in the error bar.
    notice('');
    throw error;
  } finally {
    setState({ busy: false });
  }
  const refreshed = await refresh(preloadedBoard(receipt));
  notice(
    refreshed
      ? 'Changes saved.'
      : 'Changes saved, but refreshing failed. Use Refresh before continuing.',
    !refreshed,
  );
  return { receipt, refreshed };
}
// Card placement and archive state are reordered locally before the write is
// acknowledged so a drag feels immediate. The command still carries the board
// revision, the save is still announced, and a rejected write is rolled back to
// the exact previous placement rather than left silently applied.
const OPTIMISTIC_KINDS = new Set(['item.move', 'item.rank', 'item.archive', 'item.restore']);
// Returns the store patch for the optimistic placement, or undefined.
/**
 * @param {Readonly<Flux.State>} current
 * @param {Flux.Command} command
 * @returns {Partial<Flux.State> | undefined}
 */
export function optimisticPatch(current, command) {
  const board = current.board;
  if (!board || !OPTIMISTIC_KINDS.has(command.kind)) return undefined;
  if (command.kind === 'item.archive') {
    if (!board.items.some((value) => value.id === command.target)) return undefined;
    return {
      board: { ...board, items: board.items.filter((value) => value.id !== command.target) },
    };
  }
  if (command.kind === 'item.restore') {
    if (!current.archiveItems.some((value) => value.id === command.target)) return undefined;
    return { archiveItems: current.archiveItems.filter((value) => value.id !== command.target) };
  }
  const index = board.items.findIndex((value) => value.id === command.target);
  if (index < 0) return undefined;
  if (
    command.kind === 'item.move' &&
    !board.columns.some((value) => value.id === command.destination)
  )
    return undefined;
  const moved =
    command.kind === 'item.move' && command.destination
      ? { ...board.items[index], column_id: command.destination }
      : board.items[index];
  const items = board.items.filter((_value, position) => position !== index);
  let at = items.length;
  if (command.before) {
    at = items.findIndex((value) => value.id === command.before);
    if (at < 0) return undefined;
  }
  items.splice(at, 0, moved);
  return {
    board: {
      ...board,
      items: items.map((value, rank) => (value.rank === rank ? value : { ...value, rank })),
    },
  };
}
// Applies the optimistic patch and returns its rollback: the exact previous
// values, restored only while the optimistic ones are still current.
/** @param {Flux.Command} command */
function optimisticApply(command) {
  const patch = optimisticPatch(state, command);
  if (!patch) return undefined;
  const previous = Object.fromEntries(
    /** @type {(keyof Flux.State)[]} */ (Object.keys(patch)).map((key) => [key, state[key]]),
  );
  setState(patch);
  return () => {
    if (
      Object.entries(patch).every(
        ([key, value]) => state[/** @type {keyof Flux.State} */ (key)] === value,
      )
    )
      setState(previous);
  };
}
/**
 * @param {Readonly<Flux.State>} current
 * @param {string | undefined} id
 */
function itemTitle(current, id) {
  return findItem(id, current)?.title || 'work item';
}
// The inverse must be read before the command is applied, because a move undo
// is expressed as the anchor the card currently sits in front of.
/**
 * @param {Readonly<Flux.State>} current
 * @param {Flux.Command} command
 * @returns {{ text: string, commands: Flux.Command[] } | undefined}
 */
export function undoableInverse(current, command) {
  const board = current.board;
  switch (command.kind) {
    case 'item.archive': {
      const item = findItem(command.target, current);
      return {
        text: `Archived “${itemTitle(current, command.target)}”`,
        commands: [
          {
            kind: 'item.restore',
            target: command.target,
            restore_sprint_ids: [...(item?.sprint_ids || [])],
          },
        ],
      };
    }
    case 'item.restore':
      return {
        text: `Restored “${itemTitle(current, command.target)}”`,
        commands: [{ kind: 'item.archive', target: command.target }],
      };
    case 'item.move':
    case 'item.rank': {
      if (!board) return undefined;
      const index = board.items.findIndex((value) => value.id === command.target);
      if (index < 0) return undefined;
      const item = board.items[index];
      return {
        text: `Moved “${item.title}”`,
        commands: [
          {
            kind: 'item.move',
            target: item.id,
            destination: item.column_id,
            before: board.items[index + 1]?.id || '',
          },
        ],
      };
    }
    default:
      return undefined;
  }
}
/** @param {Flux.Command} command */
export async function quick(command) {
  const full = { revision: requireBoard().workspace.revision, ...command };
  const allowed = writable();
  const undo = allowed ? undoableInverse(state, full) : undefined;
  const rollback = allowed ? optimisticApply(full) : undefined;
  try {
    await change(full);
    if (undo)
      offerUndo(`${undo.text} · undo is available for ${UNDO_TTL / 1000} seconds`, undo.commands);
  } catch (e) {
    rollback?.();
    notice(errorMessage(e), true);
  }
}
// Bulk edits are separate revision-checked commands applied in order. The
// revision from each receipt seeds the next command, so one board read settles
// the whole batch and a mid-batch conflict stops rather than skips ahead. Only
// the final command asks for the committed board; the rest take a minimal
// receipt so the batch does not pay for a board read it discards.
/**
 * @param {string} label
 * @param {Flux.Command[]} commands
 * @returns {Promise<boolean>}
 */
export async function runSequence(label, commands) {
  if (!writable()) {
    notice('Planning is read-only or a request is in progress.', true);
    return false;
  }
  if (!commands.length) {
    notice('Nothing to apply for the current selection.');
    return true;
  }
  let revision = requireBoard().workspace.revision,
    receipt,
    applied = 0,
    failure = '';
  setState({ busy: true });
  try {
    for (const [index, command] of commands.entries()) {
      notice(`${label} · ${applied}/${commands.length}…`);
      try {
        receipt = await postChange(
          { ...command, revision },
          requestKey(),
          index < commands.length - 1,
        );
        revision = receiptRevision(receipt, revision + 1);
        applied++;
      } catch (error) {
        failure = errorMessage(error);
        break;
      }
    }
  } finally {
    setState({ busy: false });
  }
  await refresh(preloadedBoard(receipt));
  notice(
    failure
      ? `${label}: applied ${applied} of ${commands.length}. ${failure}`
      : `${label}: applied ${applied} of ${commands.length}.`,
    !!failure,
  );
  return !failure;
}
