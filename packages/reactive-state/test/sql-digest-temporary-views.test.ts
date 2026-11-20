import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SchemaDigest } from '../src/sql/digest.ts';

/**
 * The schema's digest of a view of the session's temporary schema: a view's options — which rows a
 * statement that reads it sees, `security_invoker` among them — are of it as a permanent view's
 * are, where no event trigger counts the command that sets one.
 */

const RELATIONS = [{ name: 'tasks', schema: 'public' }];
/** One PGlite for the file: its first start takes seconds under load. */
const HOOK_TIMEOUT_MS = 60_000;

describe("the schema's digest of a temporary view's options", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await PGlite.create();
    await pg.exec(`
      CREATE TABLE public.tasks (id text PRIMARY KEY, title text);
      CREATE VIEW public.open_tasks AS SELECT * FROM public.tasks;
    `);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await pg.close();
  });

  /** The digest of the schema as the session reads it now, asked anew. */
  async function digestNow(): Promise<string> {
    return (await new SchemaDigest(pg, RELATIONS).read(true)).digest;
  }

  it.each([
    ['security_invoker', 'SET (security_invoker = true)'],
    ['security_barrier', 'SET (security_barrier = true)'],
    ['check_option', 'SET (check_option = local)'],
  ])('moves with %s of a view of the session', async (option, change) => {
    await pg.exec('CREATE TEMP VIEW pg_temp.mine AS SELECT * FROM public.tasks');
    try {
      const before = await digestNow();

      await pg.exec(`ALTER VIEW pg_temp.mine ${change}`);
      const set = await digestNow();
      const again = await digestNow();
      await pg.exec(`ALTER VIEW pg_temp.mine RESET (${option})`);
      const reset = await digestNow();

      expect(set).not.toBe(before);
      expect(again).toBe(set);
      expect(reset).toBe(before);
    } finally {
      await pg.exec('DROP VIEW pg_temp.mine');
    }
  });

  it('still moves with the query of the view, as it did', async () => {
    await pg.exec('CREATE TEMP VIEW pg_temp.mine AS SELECT * FROM public.tasks');
    try {
      const before = await digestNow();

      await pg.exec(
        "CREATE OR REPLACE TEMP VIEW pg_temp.mine AS SELECT * FROM public.tasks WHERE id <> 'x'",
      );

      await expect(digestNow()).resolves.not.toBe(before);
    } finally {
      await pg.exec('DROP VIEW pg_temp.mine');
    }
  });

  it("still moves with a permanent view's option, as it did", async () => {
    const before = await digestNow();
    await pg.exec('ALTER VIEW public.open_tasks SET (security_invoker = true)');
    try {
      await expect(digestNow()).resolves.not.toBe(before);
    } finally {
      await pg.exec('ALTER VIEW public.open_tasks RESET (security_invoker)');
    }
  });

  it('is the same for the same schema once a temporary view is gone', async () => {
    const before = await digestNow();
    await pg.exec('CREATE TEMP VIEW pg_temp.mine AS SELECT * FROM public.tasks');
    await pg.exec('DROP VIEW pg_temp.mine');

    await expect(digestNow()).resolves.toBe(before);
  });
});
