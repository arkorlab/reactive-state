import { prepared } from '../../../../src/server/index.ts';
import { db } from '../db.ts';

/**
 * The test application's `actions/prepared`: server operations that read what the application's
 * own server prepared for them (`prepared()`).
 */

/** Answers what it was prepared with, `null` where nothing was. */
export function echo(): unknown {
  return prepared() ?? null;
}

/** Answers whether anything was prepared. */
export function wasPrepared(): boolean {
  return prepared() !== undefined;
}

/** Reads the preparation inside the operation's transaction, and answers it. */
export async function readInTransaction(): Promise<unknown> {
  return db.transaction(async () => {
    await Promise.resolve();
    return prepared() ?? null;
  });
}

/** Reads the preparation, then throws, saying nothing of what it read. */
export function readThenThrow(): never {
  const read = prepared();
  throw new Error(read === undefined ? 'Nothing was prepared.' : 'The preparation was read.');
}
