import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { type Evaluation, evaluate } from '../src/server/context.ts';
import { followDrizzle } from '../src/sql/index.ts';

/**
 * A D1 call of a server operation — a statement's `run`, `all`, `first` or `raw`, the binding's
 * `batch` or `exec` — is counted as under way until D1 answers it, so that a change of the
 * session asked beside one that D1 then rolls back is refused.
 */

const tasks = sqliteTable('tasks', { id: text().primaryKey(), title: text().notNull() });

/** A D1 call not yet answered: how the test answers it. */
interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/** A D1 binding whose every call waits for the test to answer it. */
function waiting() {
  const calls: Pending[] = [];
  const pending = (): Promise<unknown> => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    calls.push({ reject, resolve });
    return promise;
  };
  const statement: Record<string, unknown> = {
    all: pending,
    first: pending,
    raw: pending,
    run: pending,
  };
  statement['bind'] = () => statement;
  const binding = { batch: pending, exec: pending, prepare: () => statement };
  return { binding, calls };
}

/** The binding as the application holds it, tracked. */
interface Tracked {
  readonly batch: (statements: unknown[]) => Promise<unknown>;
  readonly exec: (sql: string) => Promise<unknown>;
  readonly prepare: (sql: string) => Record<string, () => Promise<unknown>>;
}

/** `binding`, followed as the application's Drizzle is given it. */
function trackedOf(binding: unknown): Tracked {
  return followDrizzle({ tasks }).client(binding as never);
}

/** An operation's evaluation that counts the probes registered and not yet unregistered. */
function counting(): { readonly evaluation: Evaluation; readonly open: () => number } {
  const probes = new Set<WeakKey>();
  const evaluation = {
    applicationConnection: (connection: WeakKey) => {
      probes.add(connection);
      return () => {
        probes.delete(connection);
      };
    },
  } as unknown as Evaluation;
  return { evaluation, open: () => probes.size };
}

describe('a D1 call of an operation under way', () => {
  it('counts a batch until D1 rejects it, though nothing awaits it before', async () => {
    const { binding, calls } = waiting();
    const d1 = trackedOf(binding);
    const { evaluation, open } = counting();

    await evaluate(evaluation, async () => {
      const batch = d1.batch([d1.prepare("INSERT INTO tasks VALUES ('a', 'one')")]);

      expect(open()).toBe(1);

      calls[0]?.reject(new Error('rolled back'));

      await expect(batch).rejects.toThrow('rolled back');

      expect(open()).toBe(0);
    });
  });

  it.each(['run', 'all', 'first', 'raw'])(
    'counts a statement’s %s until D1 answers it',
    async (method) => {
      const { binding, calls } = waiting();
      const d1 = trackedOf(binding);
      const { evaluation, open } = counting();

      await evaluate(evaluation, async () => {
        const answered = d1.prepare('SELECT id FROM tasks')[method]?.();

        expect(open()).toBe(1);

        calls[0]?.resolve([]);
        await answered;

        expect(open()).toBe(0);
      });
    },
  );

  it('counts an exec until D1 answers it', async () => {
    const { binding, calls } = waiting();
    const d1 = trackedOf(binding);
    const { evaluation, open } = counting();

    await evaluate(evaluation, async () => {
      const answered = d1.exec('SELECT 1');

      expect(open()).toBe(1);

      calls[0]?.resolve({ count: 1 });
      await answered;

      expect(open()).toBe(0);
    });
  });

  it('counts nothing outside an operation', async () => {
    const { binding, calls } = waiting();
    const d1 = trackedOf(binding);
    const { open } = counting();
    const answered = d1.exec('SELECT 1');

    expect(open()).toBe(0);

    calls[0]?.resolve({});
    await answered;
  });
});
