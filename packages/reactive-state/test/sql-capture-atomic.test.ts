import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';

import { changeCaptureSql } from '../src/sql/capture.ts';

/**
 * The functions of the capture that only the role that made the log may execute are made, each, with
 * what `PUBLIC` is given of it taken away in one statement: no statement of the install leaves one
 * executable by a role that may use the log's schema, where each statement commits by itself. The
 * roles of these rows: `migrator`, which makes the table and the log and is no superuser, and
 * `reader`, which may use the log's schema.
 */

const RELATIONS = [{ keys: ['id'], name: 'items', schema: 'public' }];
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 30_000;
/** The functions only the role that made the log may execute, by their signatures. */
const RESTRICTED: Readonly<Record<string, string>> = {
  capture_all: 'capture_all()',
  capture_deleted: 'capture_deleted()',
  capture_inserted: 'capture_inserted()',
  capture_updated: 'capture_updated()',
  note: 'note(text, text)',
};

/** A PGlite whose log's schema was made, and `reader` may use, before the install: it runs as `migrator`. */
async function opened(): Promise<PGlite> {
  const pg = await PGlite.create();
  onTestFinished(async () => {
    await pg.close();
  });
  await pg.exec(`
    CREATE ROLE migrator;
    CREATE ROLE reader;
    GRANT CREATE ON DATABASE postgres TO migrator;
    GRANT CREATE ON SCHEMA public TO migrator;
    CREATE SCHEMA reactive_state AUTHORIZATION migrator;
    GRANT USAGE ON SCHEMA reactive_state TO reader;
    SET ROLE migrator;
    CREATE TABLE public.items (id text PRIMARY KEY, label text);
  `);
  return pg;
}

/** The functions of the log among `names` that exist, are definers' and `reader` may execute. */
async function executable(pg: PGlite, definers: boolean): Promise<readonly string[]> {
  const { rows } = await pg.query<{ name: string }>(
    `SELECT p.proname AS name FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'reactive_state' AND p.proname = ANY($1)
       AND has_function_privilege('reader', p.oid, 'EXECUTE') AND (NOT $2 OR p.prosecdef)
     ORDER BY p.proname`,
    [Object.keys(RESTRICTED), definers],
  );
  return rows.map((row) => row.name);
}

/** The log as an installation made before the functions were definers left it: invoker's, public. */
async function madeBefore(pg: PGlite): Promise<void> {
  for (const statement of changeCaptureSql(RELATIONS)) {
    await pg.query(statement);
  }
  for (const signature of Object.values(RESTRICTED)) {
    await pg.exec(`
      ALTER FUNCTION reactive_state.${signature} SECURITY INVOKER;
      GRANT EXECUTE ON FUNCTION reactive_state.${signature} TO PUBLIC;
    `);
  }
}

/** Whether `statement` makes `note`, or takes `PUBLIC`'s execution from it. */
function mentionsNote(statement: string): boolean {
  return statement.includes('."note"(');
}

/** A PGlite whose install stopped after the statement that makes `note`, over functions made before or not. */
async function installedUntilNote(over: boolean): Promise<PGlite> {
  const pg = await opened();
  if (over) {
    await madeBefore(pg);
  }
  for (const statement of changeCaptureSql(RELATIONS)) {
    await pg.query(statement);
    if (mentionsNote(statement)) {
      break;
    }
  }
  return pg;
}

/** How many entries the log holds. */
async function entries(pg: PGlite): Promise<number> {
  const { rows } = await pg.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM reactive_state.changes',
  );
  return rows[0]?.n ?? -1;
}

/** What `reader` is answered where it calls `note`: it ran, or why it did not. */
async function callsNote(pg: PGlite): Promise<string> {
  await pg.exec('RESET ROLE; SET ROLE reader');
  try {
    await pg.query("SELECT reactive_state.note('public', 'items')");
    return 'ran';
  } catch (error) {
    return String((error as { message?: unknown }).message);
  } finally {
    await pg.exec('RESET ROLE; SET ROLE migrator');
  }
}

describe('the statements that make the functions of the capture', () => {
  it(
    'leave none of them executable by a role that may use the log’s schema after any statement, of a first install',
    async () => {
      const pg = await opened();
      const seen: (readonly string[])[] = [];

      for (const statement of changeCaptureSql(RELATIONS)) {
        await pg.query(statement);
        seen.push(await executable(pg, false));
      }

      expect(seen.filter((names) => names.length > 0)).toStrictEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leave none of them a definer’s that such a role may execute after any statement, of an install over functions made before',
    async () => {
      const pg = await opened();
      await madeBefore(pg);
      const seen: (readonly string[])[] = [];

      for (const statement of changeCaptureSql(RELATIONS)) {
        await pg.query(statement);
        seen.push(await executable(pg, true));
      }

      expect(seen.filter((names) => names.length > 0)).toStrictEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['a first install', false],
    ['an install over functions made before', true],
  ])(
    'refuse `note` to a role that may use the log’s schema where %s stops after the statement that makes it',
    async (_what, over) => {
      const pg = await installedUntilNote(over);

      await expect(callsNote(pg)).resolves.toBe('permission denied for function note');
      await expect(entries(pg)).resolves.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leave the functions the readers of the log call executable by `PUBLIC`, as they were, and the others to the installer',
    async () => {
      const pg = await opened();
      for (const statement of changeCaptureSql(RELATIONS)) {
        await pg.query(statement);
      }
      const { rows } = await pg.query<{ name: string; reader: boolean; installer: boolean }>(`
        SELECT p.proname AS name,
               has_function_privilege('reader', p.oid, 'EXECUTE') AS reader,
               has_function_privilege('migrator', p.oid, 'EXECUTE') AS installer
        FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'reactive_state' AND p.proname IN
          ('capture_all', 'capture_deleted', 'capture_inserted', 'capture_updated', 'note', 'ddl_count', 'fold_ddl', 'image_sql')
        ORDER BY p.proname
      `);

      expect(rows.map((row) => [row.name, row.reader, row.installer])).toStrictEqual([
        ['capture_all', false, true],
        ['capture_deleted', false, true],
        ['capture_inserted', false, true],
        ['capture_updated', false, true],
        ['ddl_count', true, true],
        ['fold_ddl', true, true],
        ['image_sql', true, true],
        ['note', false, true],
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});
