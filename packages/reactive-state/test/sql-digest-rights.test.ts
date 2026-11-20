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

/** What `b` reads of `read` and whether the digest moves, once `change` ran as the superuser. */
async function changing({ change, read, setup }: Omit<Case, 'rows'>): Promise<Outcome> {
  const pg = await PGlite.create();
  onTestFinished(async () => {
    await pg.close();
  });
  await pg.exec(BASE + setup);
  const digest = new SchemaDigest(pg, RELATIONS);
  const idsRead = async (): Promise<string> => {
    const { rows } = await pg.query<{ id: string }>(read);
    return rows.map((row) => row.id).join(',');
  };
  await pg.exec('SET ROLE b');
  await digest.read(true);
  const before = await idsRead();

  await pg.exec('RESET ROLE');
  await pg.exec(change);
  await pg.exec('SET ROLE b');
  const after = await idsRead();
  const { changed } = await digest.read(true);
  return { moved: changed, rows: [before, after] };
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
