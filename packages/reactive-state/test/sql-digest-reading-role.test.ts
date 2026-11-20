import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';

import { SchemaDigest } from '../src/sql/digest.ts';

/**
 * The schema's digest of the role a statement reads as. What a policy of a table says of a row can
 * name that role (`current_user`, `session_user`), so the rows a statement reads differ with it
 * where nothing of the schema does; the digest holds the role by name, as the readers' rights it
 * holds do not tell one reader from another where each of them is one.
 */

const RELATIONS = [{ name: 'tasks', schema: 'public' }];
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 30_000;

/** The table, its policy `policy` (of `USING`), the roles and what `ddl` adds, in a PGlite. */
async function opened(policy: string, ddl: string): Promise<PGlite> {
  const pg = await PGlite.create();
  onTestFinished(async () => {
    await pg.close();
  });
  await pg.exec(`
    CREATE TABLE public.tasks (id text PRIMARY KEY, owner_name text NOT NULL);
    INSERT INTO tasks VALUES ('t1', 'a'), ('t2', 'b');
    CREATE ROLE a; CREATE ROLE b; CREATE ROLE x; CREATE ROLE y;
    GRANT a TO x, y;
    GRANT SELECT ON tasks TO a, b;
    ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
    CREATE POLICY seen ON tasks FOR SELECT USING (${policy});
    ${ddl}
  `);
  return pg;
}

/** The ids of `tasks` the session reads. */
async function idsRead(pg: PGlite): Promise<string> {
  const { rows } = await pg.query<{ id: string }>('SELECT id FROM tasks ORDER BY id');
  return rows.map((row) => row.id).join(',');
}

/** What `SchemaDigest.read` answers where its query failed, which it reports and does not throw. */
const UNREAD = /^unread-/u;

/** The digest as it is read now, which is one that was read: not the answer of a read that failed. */
async function readNow(digest: SchemaDigest): Promise<{ changed: boolean; digest: string }> {
  const read = await digest.read(true);

  expect(read.digest).not.toMatch(UNREAD);

  return read;
}

/** One view of the application's for each of the roles `a` and `b`, each owned by its role. */
const VIEWS_OF_BOTH = `
  CREATE VIEW va AS SELECT id FROM tasks; ALTER VIEW va OWNER TO a;
  CREATE VIEW vb AS SELECT id FROM tasks; ALTER VIEW vb OWNER TO b;
  GRANT SELECT ON va, vb TO a, b;
`;

describe("the schema's digest of the role a statement reads as", () => {
  it.each([
    ['two roles that each own a view of the application', VIEWS_OF_BOTH],
    [
      'two roles of which one owns a view of the application',
      'CREATE VIEW va AS SELECT id FROM tasks; ALTER VIEW va OWNER TO a; GRANT SELECT ON va TO a, b;',
    ],
    ['two roles that own none', ''],
  ])(
    'moves with `current_user` of %s',
    async (_what, ddl) => {
      const pg = await opened('owner_name = current_user', ddl);
      const digest = new SchemaDigest(pg, RELATIONS);
      await pg.exec('SET ROLE a');
      const asA = await readNow(digest);
      const idsA = await idsRead(pg);

      await pg.exec('RESET ROLE; SET ROLE b');
      const asB = await readNow(digest);
      const idsB = await idsRead(pg);
      await pg.exec('RESET ROLE; SET ROLE a');
      const backAsA = await readNow(digest);

      expect([idsA, idsB]).toStrictEqual(['t1', 't2']);
      expect(asB.changed).toBe(true);
      expect(asB.digest).not.toBe(asA.digest);
      expect(backAsA.digest).toBe(asA.digest);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'holds while the role does not change, as two reads of one session agree',
    async () => {
      const pg = await opened('owner_name = current_user', VIEWS_OF_BOTH);
      const digest = new SchemaDigest(pg, RELATIONS);
      await pg.exec('SET ROLE b');

      const first = await readNow(digest);
      const second = await readNow(digest);

      expect(second).toStrictEqual({ changed: false, digest: first.digest });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'moves with `session_user`, of one role the session switched to by two logins',
    async () => {
      const pg = await opened('owner_name = session_user', '');
      await pg.exec("UPDATE tasks SET owner_name = CASE id WHEN 't1' THEN 'x' ELSE 'y' END");
      const digest = new SchemaDigest(pg, RELATIONS);
      await pg.exec('SET SESSION AUTHORIZATION x; SET ROLE a');
      const asX = await readNow(digest);
      const idsX = await idsRead(pg);

      await pg.exec('RESET ROLE; SET SESSION AUTHORIZATION y; SET ROLE a');
      const asY = await readNow(digest);
      const idsY = await idsRead(pg);
      await pg.exec('RESET ROLE; SET SESSION AUTHORIZATION x; SET ROLE a');
      const backAsX = await readNow(digest);

      expect([idsX, idsY]).toStrictEqual(['t1', 't2']);
      expect(asY.changed).toBe(true);
      expect(asY.digest).not.toBe(asX.digest);
      expect(backAsX.digest).toBe(asX.digest);
    },
    TEST_TIMEOUT_MS,
  );
});
