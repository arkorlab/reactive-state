import type { Row } from './rows.ts';

/** What a statement is bound with: everything the authority writes is text or a number. */
export type SqlParameter = bigint | number | string | null;

/**
 * The SQLite the authority keeps its data in: Node's own driver on a developer's machine
 * (`node-sql.ts`), or a Durable Object's storage on Cloudflare (`cloudflare/sql.ts`). Every call is
 * synchronous, as both are, and runs one statement.
 *
 * Neither has the authority issue `BEGIN` itself — a Durable Object's storage refuses it — so a
 * group of statements that must land together is handed to `transaction`, which commits all of
 * them or, when the body throws, none. A body is synchronous and is never another transaction's.
 */
export interface SqlDriver {
  all(query: string, ...parameters: readonly SqlParameter[]): readonly Row[];
  get(query: string, ...parameters: readonly SqlParameter[]): Row | undefined;
  run(query: string, ...parameters: readonly SqlParameter[]): void;
  transaction<T>(body: () => T): T;
  close(): void;
}

/** A transaction's body handed back a promise: what it awaited would run after the commit. */
export function refuseAsync(result: unknown): void {
  if (result instanceof Promise) {
    throw new TypeError('A transaction runs a synchronous body; this one returned a promise');
  }
}
