import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';

import { changeCaptureSql } from '../src/sql/capture.ts';

/**
 * The functions of the capture that only the role that made the log may execute are made with what
 * every other role is given of them taken away in one statement, the log's own, which is one
 * transaction: no statement of the install leaves one executable by a role that may use the log's
 * schema, and one that fails leaves nothing it made. The roles of these rows: `migrator`, which
 * makes the table and the log and is no superuser, and `reader`, which may use the log's schema.
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
  hold: 'hold(text)',
  image_sql: 'image_sql(oid, text[])',
  note: 'note(text, text)',
  settle: 'settle()',
};
/** Those of them that run as the role that made the log, whoever's statement enters them. */
const DEFINERS = [
  'capture_all',
  'capture_deleted',
  'capture_inserted',
  'capture_updated',
  'settle',
];

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

/** The functions of the log among the restricted that exist, are definers' and `reader` may execute. */
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

/** The log as an installation made before left its functions: executable by `PUBLIC`. */
async function madeBefore(pg: PGlite): Promise<void> {
  for (const statement of changeCaptureSql(RELATIONS)) {
    await pg.query(statement);
  }
  for (const signature of Object.values(RESTRICTED)) {
    await pg.exec(`GRANT EXECUTE ON FUNCTION reactive_state.${signature} TO PUBLIC`);
  }
}

/** A PGlite as `opened` makes it, over which such an installation was made. */
async function openedOver(): Promise<PGlite> {
  const pg = await opened();
  await madeBefore(pg);
  return pg;
}

/** How many functions the log's schema holds. */
async function functions(pg: PGlite): Promise<number> {
  const { rows } = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'reactive_state'`,
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
      const pg = await openedOver();

      await expect(executable(pg, true)).resolves.toStrictEqual(DEFINERS);

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
    ['a first install', opened],
    ['an install over functions made before', openedOver],
  ])(
    'refuse `note` to a role that may use the log’s schema once the statement of %s that makes it has run',
    async (_what, make) => {
      const pg = await make();
      const [log = ''] = changeCaptureSql(RELATIONS);

      await pg.query(log);

      await expect(callsNote(pg)).resolves.toBe('permission denied for function note');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'make nothing where the statement of the log fails after it made them: no function is left for any role',
    async () => {
      const pg = await opened();
      // The count of the schema's commands is made after the functions: of a view in its place, the
      // statement fails there, as it alters what it takes for its table.
      await pg.exec('CREATE VIEW reactive_state.ddl AS SELECT 1 AS "at"');
      const [log = ''] = changeCaptureSql(RELATIONS);

      await expect(pg.query(log)).rejects.toThrow('"ddl"');
      await expect(functions(pg)).resolves.toBe(0);
      await expect(executable(pg, false)).resolves.toStrictEqual([]);
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
        WHERE n.nspname = 'reactive_state' AND p.prorettype <> 'event_trigger'::regtype
        ORDER BY p.proname
      `);

      expect(rows.map((row) => [row.name, row.reader, row.installer])).toStrictEqual([
        ['capture_all', false, true],
        ['capture_deleted', false, true],
        ['capture_inserted', false, true],
        ['capture_updated', false, true],
        ['catch_up', true, true],
        ['ddl_count', true, true],
        ['fold_ddl', true, true],
        ['hold', false, true],
        ['image_sql', false, true],
        ['next_number', true, true],
        ['note', false, true],
        ['prune', true, true],
        ['settle', false, true],
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});
