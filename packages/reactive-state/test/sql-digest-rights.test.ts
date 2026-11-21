import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';

import { SchemaDigest } from '../src/sql/digest.ts';

/**
 * The schema's digest of whose rights a statement reads under: a change of the rights or of the
 * attributes of a role a statement reads as, which changes the rows it reads, moves the digest. The
 * readers are the session's role and the owner of each view a statement may read through — of the
 * application's, and of the session's temporary schema — whose rights a view that is no
 * `security_invoker` reads its tables by. Each row reads `tasks`, or a view of it, as the role `b`
 * before and after the superuser changes something, and says what `b` read and whether the digest
 * moved.
 */

const RELATIONS = [{ name: 'tasks', schema: 'public' }];
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 30_000;
const BASE = `
  CREATE TABLE public.tasks (id text PRIMARY KEY, owner_name text NOT NULL);
  INSERT INTO tasks VALUES ('t1', 'a'), ('t2', 'b'), ('t3', 'c');
  CREATE ROLE a; CREATE ROLE b; CREATE ROLE c;
  CREATE ROLE admins; CREATE ROLE g1; CREATE ROLE g2;
  GRANT SELECT ON tasks TO a, b, c;
  ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
`;

/** What `b` reads of a statement it may not read. */
const DENIED = 'denied';
/** A policy that lets `a` read every row, so that a view of `a`'s lets `b` read them. */
const A_SEES = 'CREATE POLICY own ON tasks FOR SELECT TO a USING (true);';

/** What is set up, what `b` reads, what the superuser changes, and what `b` reads before and after. */
interface Case {
  readonly setup: string;
  readonly read: string;
  readonly change: string;
  readonly rows: readonly [string, string];
}

interface Outcome {
  readonly rows: readonly [string, string];
  readonly moved: boolean;
}

/** What `SchemaDigest.read` answers where its query failed, which it reports and does not throw. */
const UNREAD = /^unread-/u;

/** The digest as it is read now, which is one that was read: not the answer of a read that failed. */
async function readNow(digest: SchemaDigest): Promise<{ changed: boolean; digest: string }> {
  const read = await digest.read(true);

  expect(read.digest).not.toMatch(UNREAD);

  return read;
}

/** What `b` reads of `read` and whether the digest moves, once `change` ran as the superuser. */
async function changing({ change, read, setup }: Omit<Case, 'rows'>): Promise<Outcome> {
  const pg = await PGlite.create();
  onTestFinished(async () => {
    await pg.close();
  });
  await pg.exec(BASE + setup);
  const digest = new SchemaDigest(pg, RELATIONS);
  const idsRead = async (): Promise<string> => {
    try {
      const { rows } = await pg.query<{ id: string }>(read);
      return rows.map((row) => row.id).join(',');
    } catch (error) {
      // A statement `b` may no longer read fails: the row says it was refused.
      if (String((error as { message?: unknown }).message).startsWith('permission denied')) {
        return DENIED;
      }
      throw error;
    }
  };
  await pg.exec('SET ROLE b');
  await readNow(digest);
  const before = await idsRead();

  await pg.exec('RESET ROLE');
  await pg.exec(change);
  await pg.exec('SET ROLE b');
  const after = await idsRead();
  const moved = await readNow(digest);

  // Asked again at once, it is what it was: a read that failed says it changed each time.
  await expect(readNow(digest)).resolves.toStrictEqual({ changed: false, digest: moved.digest });

  return { moved: moved.changed, rows: [before, after] };
}

const READ_TASKS = 'SELECT id FROM tasks ORDER BY id';
const THROUGH_VIEW = 'SELECT id FROM va ORDER BY id';
const THROUGH_TEMPORARY = 'SELECT id FROM pg_temp.tv ORDER BY id';
/** A view of `tasks` owned by `a`, which `b` may read. */
const VIEW_OF_A = `
  CREATE VIEW va AS SELECT * FROM tasks; ALTER VIEW va OWNER TO a; GRANT SELECT ON va TO b;
`;
/** A view of `tasks` in the session's temporary schema, made as `a`, which `b` may read. */
const TEMPORARY_VIEW_OF_A = `
  SET ROLE a; CREATE TEMP VIEW tv AS SELECT * FROM tasks; GRANT SELECT ON pg_temp.tv TO b; RESET ROLE;
`;
const ONLY_T1 = "CREATE POLICY seen ON tasks FOR SELECT TO b USING (id = 't1');";
const ADMINS_SEE = 'CREATE POLICY admin ON tasks FOR SELECT TO admins USING (true);';
const ALL_THREE = 't1,t2,t3';
/** A function of the session's temporary schema, made as `a`, which `PUBLIC` may execute. */
const TEMPORARY_FUNCTION_OF_A = `
  SET ROLE a; CREATE FUNCTION pg_temp.f() RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$; RESET ROLE;
`;
/** The same, `PUBLIC`'s execution taken away, and `a` and `b` given it. */
const TEMPORARY_FUNCTION_FOR_A_AND_B = `${TEMPORARY_FUNCTION_OF_A}
  REVOKE EXECUTE ON FUNCTION pg_temp.f() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION pg_temp.f() TO a, b;
`;
const CALL_TEMPORARY_FUNCTION = 'SELECT pg_temp.f() AS id';
/** A type of the session's temporary schema, made as `a`, which `PUBLIC` may use. */
const TEMPORARY_TYPE_OF_A = `
  SET ROLE a; CREATE TYPE pg_temp.mood AS ENUM ('ok'); RESET ROLE;
`;
const USE_TEMPORARY_TYPE = "SELECT 'ok'::pg_temp.mood::text AS id";
/** A table of the session's temporary schema of a name of the application's, made as `a`. */
const TEMPORARY_TABLE_OF_A = `
  SET ROLE a; CREATE TEMP TABLE tasks (id text, x text); INSERT INTO pg_temp.tasks VALUES ('t', 'u');
  GRANT SELECT (id), SELECT (x) ON pg_temp.tasks TO b; RESET ROLE;
`;
const READ_TEMPORARY_TABLE = 'SELECT x AS id FROM pg_temp.tasks';
/** The same, which `b` may read as a whole. */
const TEMPORARY_TABLE_FOR_B = `
  SET ROLE a; CREATE TEMP TABLE tasks (id text, x text); INSERT INTO pg_temp.tasks VALUES ('t', 'u');
  GRANT SELECT ON pg_temp.tasks TO b; RESET ROLE;
`;
/** A function of the application's, which `PUBLIC` may execute. */
const APPLICATION_FUNCTION = `
  CREATE FUNCTION public.af() RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$;
`;
const CALL_APPLICATION_FUNCTION = 'SELECT public.af() AS id';
/** What `b` reads of a column of the temporary view, the owners' names of the rows `a` sees. */
const NAMES = 'a,b,c';
const THROUGH_COLUMN = 'SELECT owner_name AS id FROM pg_temp.tv ORDER BY 1';
/** A view of `tasks` in the session's temporary schema, made as `a`, of which `b` may read the columns. */
const TEMPORARY_COLUMNS_OF_A = `
  SET ROLE a; CREATE TEMP VIEW tv AS SELECT id, owner_name FROM tasks;
  GRANT SELECT (id), SELECT (owner_name) ON pg_temp.tv TO b; RESET ROLE;
`;
/** A view of `tasks` in the session's temporary schema, made as `a`, which only `g1` may read. */
const TEMPORARY_VIEW_FOR_G1 = `
  SET ROLE a; CREATE TEMP VIEW tv AS SELECT id, owner_name FROM tasks;
  GRANT SELECT ON pg_temp.tv TO g1; RESET ROLE;
`;
/** `a` and `c` each own a view of the application's, and a policy each lets through other rows. */
const A_AND_C_OWN_VIEWS = `
  CREATE POLICY pa ON tasks FOR SELECT TO a USING (id = 't1');
  CREATE POLICY pc ON tasks FOR SELECT TO c USING (true);
  CREATE VIEW va AS SELECT id FROM tasks; ALTER VIEW va OWNER TO a;
  CREATE VIEW vc AS SELECT id FROM tasks; ALTER VIEW vc OWNER TO c;
`;

describe("the schema's digest of whose rights a statement reads under", () => {
  it.each<readonly [string, Case]>([
    [
      'its owner is let past every policy',
      {
        change: 'ALTER ROLE a BYPASSRLS',
        read: THROUGH_TEMPORARY,
        rows: ['', ALL_THREE],
        setup: ONLY_T1 + TEMPORARY_VIEW_OF_A,
      },
    ],
    [
      'its owner is granted a role a policy names',
      {
        change: 'GRANT admins TO a',
        read: THROUGH_TEMPORARY,
        rows: ['', ALL_THREE],
        setup: ADMINS_SEE + TEMPORARY_VIEW_OF_A,
      },
    ],
    [
      'the reader may no longer read it',
      {
        change: 'REVOKE SELECT ON pg_temp.tv FROM b',
        read: THROUGH_TEMPORARY,
        rows: [ALL_THREE, DENIED],
        setup: A_SEES + TEMPORARY_VIEW_OF_A,
      },
    ],
    [
      'a role that reads nothing is given the right to read it',
      {
        change: 'GRANT SELECT ON pg_temp.tv TO c',
        read: THROUGH_TEMPORARY,
        rows: [ALL_THREE, ALL_THREE],
        setup: A_SEES + TEMPORARY_VIEW_OF_A,
      },
    ],
    [
      'the reader may no longer read a column of it, and still reads another',
      {
        change: 'REVOKE SELECT (owner_name) ON pg_temp.tv FROM b',
        read: THROUGH_COLUMN,
        rows: [NAMES, DENIED],
        setup: A_SEES + TEMPORARY_COLUMNS_OF_A,
      },
    ],
    [
      'a role that reads nothing is given the right to read a column of it',
      {
        change: 'GRANT SELECT (owner_name) ON pg_temp.tv TO c',
        read: THROUGH_COLUMN,
        rows: [NAMES, NAMES],
        setup: A_SEES + TEMPORARY_COLUMNS_OF_A,
      },
    ],
    [
      'its owner is replaced by another role that reads, with the same right to read it',
      {
        change: 'ALTER VIEW pg_temp.tv OWNER TO c; GRANT SELECT ON pg_temp.tv TO a, b, c',
        read: THROUGH_TEMPORARY,
        rows: ['t1', ALL_THREE],
        setup: `${A_AND_C_OWN_VIEWS} SET ROLE a; CREATE TEMP VIEW tv AS SELECT * FROM tasks; GRANT SELECT ON pg_temp.tv TO a, b, c; RESET ROLE;`,
      },
    ],
    [
      'the reader is granted a role that may read it',
      {
        change: 'GRANT g1 TO b',
        read: THROUGH_COLUMN,
        rows: [DENIED, NAMES],
        setup: A_SEES + TEMPORARY_VIEW_FOR_G1,
      },
    ],
    [
      'the reader is granted a role that may read a column of it',
      {
        change: 'GRANT g1 TO b',
        read: THROUGH_COLUMN,
        rows: [DENIED, NAMES],
        setup: `${A_SEES} SET ROLE a; CREATE TEMP VIEW tv AS SELECT id, owner_name FROM tasks; GRANT SELECT (owner_name) ON pg_temp.tv TO g1; RESET ROLE;`,
      },
    ],
  ])(
    'moves with a view of the session’s temporary schema, made by another role, once %s',
    async (_what, given) => {
      const outcome = await changing(given);

      expect(outcome.rows).toStrictEqual(given.rows);
      expect(outcome.moved).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it.each<readonly [string, Case]>([
    [
      'its execution is taken from PUBLIC',
      {
        change: 'REVOKE EXECUTE ON FUNCTION pg_temp.f() FROM PUBLIC',
        read: CALL_TEMPORARY_FUNCTION,
        rows: ['x', DENIED],
        setup: TEMPORARY_FUNCTION_OF_A,
      },
    ],
    [
      'a role that reads nothing is given its execution',
      {
        change: 'GRANT EXECUTE ON FUNCTION pg_temp.f() TO c',
        read: CALL_TEMPORARY_FUNCTION,
        rows: ['x', 'x'],
        setup: TEMPORARY_FUNCTION_FOR_A_AND_B,
      },
    ],
    [
      'it has another owner',
      {
        change: 'ALTER FUNCTION pg_temp.f() OWNER TO c',
        read: CALL_TEMPORARY_FUNCTION,
        rows: ['x', 'x'],
        setup: TEMPORARY_FUNCTION_OF_A,
      },
    ],
    [
      'the reader is granted a role that may execute it',
      {
        change: 'GRANT g1 TO b',
        read: CALL_TEMPORARY_FUNCTION,
        rows: [DENIED, 'x'],
        setup: `${TEMPORARY_FUNCTION_OF_A} REVOKE EXECUTE ON FUNCTION pg_temp.f() FROM PUBLIC; GRANT EXECUTE ON FUNCTION pg_temp.f() TO a, g1;`,
      },
    ],
  ])(
    'moves with a function of the session’s temporary schema, once %s',
    async (_what, given) => {
      const outcome = await changing(given);

      expect(outcome.rows).toStrictEqual(given.rows);
      expect(outcome.moved).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it.each<readonly [string, Case]>([
    [
      'its use is taken from PUBLIC',
      {
        change: 'REVOKE USAGE ON TYPE pg_temp.mood FROM PUBLIC',
        read: USE_TEMPORARY_TYPE,
        rows: ['ok', 'ok'],
        setup: TEMPORARY_TYPE_OF_A,
      },
    ],
    [
      'a role that reads nothing is given its use',
      {
        change: 'GRANT USAGE ON TYPE pg_temp.mood TO c',
        read: USE_TEMPORARY_TYPE,
        rows: ['ok', 'ok'],
        setup: `${TEMPORARY_TYPE_OF_A} REVOKE USAGE ON TYPE pg_temp.mood FROM PUBLIC; GRANT USAGE ON TYPE pg_temp.mood TO a, b;`,
      },
    ],
    [
      'it has another owner',
      {
        change: 'ALTER TYPE pg_temp.mood OWNER TO c',
        read: USE_TEMPORARY_TYPE,
        rows: ['ok', 'ok'],
        setup: TEMPORARY_TYPE_OF_A,
      },
    ],
  ])(
    'moves with a type of the session’s temporary schema, once %s',
    async (_what, given) => {
      const outcome = await changing(given);

      expect(outcome.rows).toStrictEqual(given.rows);
      expect(outcome.moved).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it.each<readonly [string, Case]>([
    [
      'the reader may no longer read it',
      {
        change: 'REVOKE SELECT ON pg_temp.tasks FROM b',
        read: READ_TEMPORARY_TABLE,
        rows: ['u', DENIED],
        setup: TEMPORARY_TABLE_FOR_B,
      },
    ],
    [
      'the reader may no longer read a column of it',
      {
        change: 'REVOKE SELECT (x) ON pg_temp.tasks FROM b',
        read: READ_TEMPORARY_TABLE,
        rows: ['u', DENIED],
        setup: TEMPORARY_TABLE_OF_A,
      },
    ],
    [
      'a role that reads nothing is given the right to read it',
      {
        change: 'GRANT SELECT ON pg_temp.tasks TO c',
        read: READ_TEMPORARY_TABLE,
        rows: ['u', 'u'],
        setup: TEMPORARY_TABLE_OF_A,
      },
    ],
    [
      'it has another owner',
      {
        change: 'ALTER TABLE pg_temp.tasks OWNER TO c',
        read: READ_TEMPORARY_TABLE,
        rows: ['u', 'u'],
        setup: TEMPORARY_TABLE_OF_A,
      },
    ],
  ])(
    'moves with a table of the session’s temporary schema of a name of the application’s, once %s',
    async (_what, given) => {
      const outcome = await changing(given);

      expect(outcome.rows).toStrictEqual(given.rows);
      expect(outcome.moved).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it.each<readonly [string, Case]>([
    [
      'a view of the application’s, once its owner is let past every policy',
      {
        change: 'ALTER ROLE a BYPASSRLS',
        read: THROUGH_VIEW,
        rows: ['', ALL_THREE],
        setup: ONLY_T1 + VIEW_OF_A,
      },
    ],
    [
      'a view of the application’s, once its owner is granted a role a policy names',
      {
        change: 'GRANT admins TO a',
        read: THROUGH_VIEW,
        rows: ['', ALL_THREE],
        setup: ADMINS_SEE + VIEW_OF_A,
      },
    ],
    [
      'a view of the application’s, once it has another owner',
      {
        change: 'ALTER VIEW va OWNER TO c',
        read: THROUGH_VIEW,
        rows: ['', ALL_THREE],
        setup: `CREATE POLICY c ON tasks FOR SELECT TO c USING (true); ${VIEW_OF_A}`,
      },
    ],
    [
      'a view of the application’s, once the reader may no longer read it',
      {
        change: 'REVOKE SELECT ON va FROM b',
        read: THROUGH_VIEW,
        rows: [ALL_THREE, DENIED],
        setup: A_SEES + VIEW_OF_A,
      },
    ],
    [
      'a view of the application’s, once it is read by its invoker’s rights',
      {
        change: 'ALTER VIEW va SET (security_invoker = true)',
        read: THROUGH_VIEW,
        rows: [ALL_THREE, 't1'],
        setup: `${ONLY_T1} CREATE VIEW va AS SELECT * FROM tasks; GRANT SELECT ON va TO b;`,
      },
    ],
    [
      'the role, once it is granted a role a policy asks of by `pg_has_role`',
      {
        change: 'GRANT admins TO b',
        read: READ_TASKS,
        rows: ['', ALL_THREE],
        setup:
          "CREATE POLICY via ON tasks FOR SELECT USING (pg_has_role(current_user, 'admins', 'member'));",
      },
    ],
    [
      'the role, once a role it is a member of through another no longer is',
      {
        change: 'REVOKE g1 FROM b',
        read: READ_TASKS,
        rows: [ALL_THREE, ''],
        setup:
          'GRANT g2 TO g1; GRANT g1 TO b; CREATE POLICY via ON tasks FOR SELECT TO g2 USING (true);',
      },
    ],
    [
      'a table of the application’s, once a role that reads nothing is given the right to read a column of it',
      {
        change: 'GRANT SELECT (owner_name) ON tasks TO c',
        read: READ_TASKS,
        rows: ['t1', 't1'],
        setup: ONLY_T1,
      },
    ],
    [
      'a function of the application’s, once its execution is taken from PUBLIC',
      {
        change: 'REVOKE EXECUTE ON FUNCTION public.af() FROM PUBLIC',
        read: CALL_APPLICATION_FUNCTION,
        rows: ['x', DENIED],
        setup: APPLICATION_FUNCTION,
      },
    ],
    [
      'the table, once the role owns it',
      {
        change: 'ALTER TABLE tasks OWNER TO b',
        read: READ_TASKS,
        rows: ['t1', ALL_THREE],
        setup: ONLY_T1,
      },
    ],
    [
      'the table, once a role the reader is a member of owns it',
      {
        change: 'ALTER TABLE tasks OWNER TO g1',
        read: READ_TASKS,
        rows: ['t1', ALL_THREE],
        setup: `GRANT g1 TO b; ${ONLY_T1}`,
      },
    ],
    [
      'the table, once its owner is held to its policies',
      {
        change: 'ALTER TABLE tasks FORCE ROW LEVEL SECURITY',
        read: READ_TASKS,
        rows: [ALL_THREE, 't1'],
        setup: `ALTER TABLE tasks OWNER TO b; ${ONLY_T1}`,
      },
    ],
  ])(
    'moves with %s (as it did)',
    async (_what, given) => {
      const outcome = await changing(given);

      expect(outcome.rows).toStrictEqual(given.rows);
      expect(outcome.moved).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it.each<readonly [string, Case]>([
    [
      'an attribute of a role the reader is a member of, which it does not inherit',
      {
        change: 'ALTER ROLE g2 BYPASSRLS',
        read: READ_TASKS,
        rows: ['t1', 't1'],
        setup: `GRANT g2 TO b; ${ONLY_T1}`,
      },
    ],
    [
      'execution of a function of the application’s, given to a role that reads nothing',
      {
        change: 'GRANT EXECUTE ON FUNCTION public.af() TO c',
        read: CALL_APPLICATION_FUNCTION,
        rows: ['x', 'x'],
        setup: `${APPLICATION_FUNCTION} REVOKE EXECUTE ON FUNCTION public.af() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.af() TO b;`,
      },
    ],
    [
      'a role that owns no view a statement reads through, beside a temporary view of the reader',
      {
        change: 'ALTER ROLE a BYPASSRLS',
        read: THROUGH_TEMPORARY,
        rows: ['t1', 't1'],
        setup: `${ONLY_T1} SET ROLE b; CREATE TEMP VIEW tv AS SELECT * FROM tasks; RESET ROLE;`,
      },
    ],
  ])(
    'does not move with %s',
    async (_what, given) => {
      const outcome = await changing(given);

      expect(outcome.rows).toStrictEqual(given.rows);
      expect(outcome.moved).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
