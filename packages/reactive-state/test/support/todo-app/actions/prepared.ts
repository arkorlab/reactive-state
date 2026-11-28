import { prepared } from '../../../../src/server/index.ts';

/**
 * The test application's `actions/prepared`: server operations that read what the application's
 * own server prepared for them (`prepared()`). The old application's read inside `db.transaction`
 * is not here: that transaction goes with the tables the authority keeps.
 */

/** Answers what it was prepared with, `null` where nothing was. */
export function echo(): unknown {
  return prepared() ?? null;
}

/** Answers whether anything was prepared. */
export function wasPrepared(): boolean {
  return prepared() !== undefined;
}

/** Reads the preparation, then throws, saying nothing of what it read. */
export function readThenThrow(): never {
  const read = prepared();
  throw new Error(read === undefined ? 'Nothing was prepared.' : 'The preparation was read.');
}
