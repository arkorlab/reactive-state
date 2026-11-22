import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';

import { SchemaDigest } from '../src/sql/digest.ts';

/**
 * The schema's digest of what the catalog records of the session's temporary schema and of the roles
 * that read, which it holds by whole rows: a temporary relation by its `pg_class` row but the
 * columns a write of rows moves, and by each of its `pg_attribute` rows; a role that reads by its
 * `pg_roles` row, and by its memberships' names and rows. Each row reads `tasks`, or a relation of
 * the same name or a view of the session's, as the role `b` before and after the superuser changes
 * something, and says what `b` read and whether the digest moved; where no event trigger counts the
 * command, as here, the digest is the only thing that tells a plan kept for the statement.
 */

const RELATIONS = [{ name: 'tasks', schema: 'public' }];
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 30_000;
const BASE = `
  CREATE TABLE public.tasks (id text PRIMARY KEY, owner_name text NOT NULL);
  INSERT INTO tasks VALUES ('t1', 'a'), ('t2', 'b'), ('t3', 'c');
  CREATE ROLE a; CREATE ROLE b; CREATE ROLE c; CREATE ROLE admins; CREATE ROLE guests;
  GRANT SELECT ON tasks TO a, b, c;
`;

const IDS = 't1,t2,t3';
const NAMES = 'a,b,c';
/** What `b` reads where no row is let through. */
const NOTHING = '';
/** What `b` reads of a statement that names a column or a role that is no more. */
const MISSING = 'missing';

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

/** A PGlite with `BASE` and `setup`, closed when the test is over. */
async function opened(setup: string): Promise<PGlite> {
  const pg = await PGlite.create();
  onTestFinished(async () => {
    await pg.close();
  });
  await pg.exec(BASE + setup);
  return pg;
}

/** The column `id` of what `read` reads, joined; or `MISSING` where it names what is no more. */
async function idsRead(pg: PGlite, read: string): Promise<string> {
  try {
    const { rows } = await pg.query<{ id: string }>(read);
    return rows.map((row) => row.id).join(',');
  } catch (error) {
    if (String((error as { message?: unknown }).message).includes('does not exist')) {
      return MISSING;
    }
    throw error;
  }
}

/** What `b` reads of `read` and whether the digest moves, once `change` ran as the superuser. */
async function changing({ change, read, setup }: Omit<Case, 'rows'>): Promise<Outcome> {
  const pg = await opened(setup);
  const digest = new SchemaDigest(pg, RELATIONS);
  await pg.exec('SET ROLE b');
  await readNow(digest);
  const before = await idsRead(pg, read);

  await pg.exec('RESET ROLE');
  await pg.exec(change);
  await pg.exec('SET ROLE b');
  const after = await idsRead(pg, read);
  const moved = await readNow(digest);

  // Asked again at once, it is what it was: a read that failed says it changed each time.
  await expect(readNow(digest)).resolves.toStrictEqual({ changed: false, digest: moved.digest });

  return { moved: moved.changed, rows: [before, after] };
}

/** A view of `tasks` of the session's temporary schema, which `b` may read. */
const TEMPORARY_VIEW = `
  CREATE TEMP VIEW tv AS SELECT id, owner_name FROM tasks; GRANT SELECT ON pg_temp.tv TO b;
`;
const READ_TEMPORARY_VIEW = 'SELECT id FROM pg_temp.tv ORDER BY 1';
/** A table of the session's temporary schema of a name of the application's, which `b` may read. */
const TEMPORARY_TABLE = `
  CREATE TEMP TABLE tasks (id text, x text); INSERT INTO pg_temp.tasks VALUES ('t', 'u');
  GRANT SELECT ON pg_temp.tasks TO b;
`;
const READ_TEMPORARY_TABLE = 'SELECT x AS id FROM pg_temp.tasks';
/** Another table of the application's, of the columns of `tasks`, which `b` may read. */
const ANOTHER_TABLE = `
  CREATE TABLE public.other (id text PRIMARY KEY, owner_name text NOT NULL);
  INSERT INTO other VALUES ('o1', 'z'); GRANT SELECT ON other TO b;
`;
const READ_TASKS = 'SELECT id FROM tasks ORDER BY 1';

describe("the schema's digest of what the catalog records of the session's temporary schema", () => {
  it.each<readonly [string, Case]>([
    [
      'a column of a view of the session is renamed',
      {
        change: 'ALTER VIEW pg_temp.tv RENAME COLUMN id TO renamed',
        read: READ_TEMPORARY_VIEW,
        rows: [IDS, MISSING],
        setup: TEMPORARY_VIEW,
      },
    ],
    [
      'two columns of a view of the session swap their names, so that the same statement reads another',
      {
        change: `ALTER VIEW pg_temp.tv RENAME COLUMN id TO swap;
          ALTER VIEW pg_temp.tv RENAME COLUMN owner_name TO id;
          ALTER VIEW pg_temp.tv RENAME COLUMN swap TO owner_name`,
        read: READ_TEMPORARY_VIEW,
        rows: [IDS, NAMES],
        setup: TEMPORARY_VIEW,
      },
    ],
    [
      'a column of a table of the session’s, of a name of the application’s, is renamed',
      {
        change: 'ALTER TABLE pg_temp.tasks RENAME COLUMN x TO y',
        read: READ_TEMPORARY_TABLE,
        rows: ['u', MISSING],
        setup: TEMPORARY_TABLE,
      },
    ],
    [
      'row security is enabled on a table of the session’s, of a name of the application’s, which `b` has no policy of',
      {
        change: 'ALTER TABLE pg_temp.tasks ENABLE ROW LEVEL SECURITY',
        read: READ_TEMPORARY_TABLE,
        rows: ['u', NOTHING],
        setup: TEMPORARY_TABLE,
      },
    ],
  ])(
    'moves once %s',
    async (_what, given) => {
      const outcome = await changing(given);

      expect(outcome.rows).toStrictEqual(given.rows);
      expect(outcome.moved).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it.each<readonly [string, Case]>([
    [
      'a column is renamed',
      {
        change: 'ALTER TABLE tasks RENAME COLUMN owner_name TO renamed',
        read: 'SELECT owner_name AS id FROM tasks ORDER BY 1',
        rows: [NAMES, MISSING],
        setup: '',
      },
    ],
    [
      'the reader becomes the owner of a table with row security, which an owner reads past',
      {
        change: 'ALTER TABLE tasks OWNER TO b',
        read: READ_TASKS,
        rows: [NOTHING, IDS],
        setup: 'ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;',
      },
    ],
    [
      'another table takes the name of `tasks`',
      {
        change: 'ALTER TABLE tasks RENAME TO t0; ALTER TABLE other RENAME TO tasks',
        read: READ_TASKS,
        rows: [IDS, 'o1'],
        setup: ANOTHER_TABLE,
      },
    ],
  ])(
    'still moves with the application’s own tables, once %s',
    async (_what, given) => {
      const outcome = await changing(given);

      expect(outcome.rows).toStrictEqual(given.rows);
      expect(outcome.moved).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * A session with a temporary table of a name of the application's, a view of it, a sequence of a
 * name of the application's, and a table with a rule, as the superuser, and what `b` reads them as.
 */
const TEMPORARY_OBJECTS = `
  CREATE SEQUENCE public.seq; GRANT USAGE ON SEQUENCE public.seq TO b;
  CREATE TEMP TABLE tasks (id text PRIMARY KEY, x text);
  CREATE TEMP SEQUENCE seq;
  CREATE TEMP VIEW tv AS SELECT id FROM pg_temp.tasks;
  CREATE TEMP TABLE ruled (id int);
  CREATE RULE r AS ON INSERT TO pg_temp.ruled DO ALSO NOTHING;
  GRANT SELECT ON pg_temp.tasks, pg_temp.tv TO b;
`;

/** What writes the rows of those, or moves their statistics, their files and their horizons. */
const NOT_A_CHANGE = [
  "INSERT INTO pg_temp.tasks SELECT g::text, repeat('x', 300) FROM generate_series(1, 2000) AS g",
  'INSERT INTO pg_temp.ruled VALUES (1)',
  'ANALYZE',
  'ANALYZE pg_temp.tasks',
  'VACUUM',
  'VACUUM (FREEZE, ANALYZE) pg_temp.tasks',
  "UPDATE pg_temp.tasks SET x = 'y'",
  "DELETE FROM pg_temp.tasks WHERE id > '5'",
  'VACUUM FULL pg_temp.tasks',
  'TRUNCATE pg_temp.tasks',
  "INSERT INTO pg_temp.tasks SELECT g::text, 'x' FROM generate_series(1, 100) AS g",
  "SELECT nextval('pg_temp.seq'), setval('pg_temp.seq', 50)",
  'ALTER SEQUENCE pg_temp.seq RESTART',
];

describe("the schema's digest of the session's temporary relations, held by whole rows", () => {
  it(
    'is the same on two reads of a session that did nothing between them',
    async () => {
      const pg = await opened(TEMPORARY_OBJECTS);
      const digest = new SchemaDigest(pg, RELATIONS);
      await pg.exec('SET ROLE b');

      const first = await readNow(digest);
      const second = await readNow(digest);

      expect(second).toStrictEqual({ changed: false, digest: first.digest });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is the same after what writes their rows, their statistics, their files and their horizons',
    async () => {
      const pg = await opened(TEMPORARY_OBJECTS);
      const digest = new SchemaDigest(pg, RELATIONS);
      await pg.exec('SET ROLE b');
      const first = await readNow(digest);
      const moved: string[] = [];

      for (const statement of NOT_A_CHANGE) {
        await pg.exec('RESET ROLE');
        await pg.exec(statement);
        await pg.exec('SET ROLE b');
        const read = await readNow(digest);
        if (read.digest !== first.digest) {
          moved.push(statement);
        }
      }

      expect(moved).toStrictEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

/** A policy that lets every row through to a role of which `privilege` says it has the role `admins`. */
function admins(privilege: string): string {
  return `ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
    CREATE POLICY asks ON tasks FOR SELECT USING (pg_has_role(current_user, 'admins', '${privilege}'));`;
}
/** The reader is a member of `admins`, which the policy asks of by name. */
const bIsAdmin = (privilege: string): string => `GRANT admins TO b; ${admins(privilege)}`;
/** `admins` is renamed, and the role `guests`, which the reader is no member of, takes its name. */
const SWAP_ADMINS = `ALTER ROLE admins RENAME TO former_admins; ALTER ROLE guests RENAME TO admins`;

describe("the schema's digest of the roles that read, held by their whole rows", () => {
  it.each<readonly [string, Case]>([
    [
      'a role it is a member of is renamed, and a role it is no member of takes its name',
      {
        change: SWAP_ADMINS,
        read: READ_TASKS,
        rows: [IDS, NOTHING],
        setup: bIsAdmin('member'),
      },
    ],
    [
      'a role it has the rights of is renamed, and a role it has none of takes its name',
      {
        change: SWAP_ADMINS,
        read: READ_TASKS,
        rows: [IDS, NOTHING],
        setup: bIsAdmin('usage'),
      },
    ],
    [
      'the role a policy asks of is renamed, and no role has its name',
      {
        change: 'ALTER ROLE admins RENAME TO former_admins',
        read: READ_TASKS,
        rows: [IDS, MISSING],
        setup: bIsAdmin('member'),
      },
    ],
    [
      'a role it is a member of is renamed to the name a policy asks of',
      {
        change: 'ALTER ROLE admins RENAME TO staff',
        read: READ_TASKS,
        rows: [MISSING, IDS],
        setup: `GRANT admins TO b; ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
          CREATE POLICY asks ON tasks FOR SELECT USING (pg_has_role(current_user, 'staff', 'member'));`,
      },
    ],
    [
      'it is no longer let `SET ROLE` to a role it is a member of',
      {
        change: 'REVOKE SET OPTION FOR admins FROM b',
        read: READ_TASKS,
        rows: [IDS, NOTHING],
        setup: bIsAdmin('set'),
      },
    ],
    [
      'it is given the admin option of a role it is a member of',
      {
        change: 'GRANT admins TO b WITH ADMIN OPTION',
        read: READ_TASKS,
        rows: [NOTHING, IDS],
        setup: bIsAdmin('member with admin option'),
      },
    ],
    [
      'its connection limit is set',
      {
        change: 'ALTER ROLE b CONNECTION LIMIT 5',
        read: READ_TASKS,
        rows: [IDS, IDS],
        setup: '',
      },
    ],
  ])(
    'moves once %s',
    async (_what, given) => {
      const outcome = await changing(given);

      expect(outcome.rows).toStrictEqual(given.rows);
      expect(outcome.moved).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it.each<readonly [string, Case]>([
    [
      'a role it is no member of is renamed, and another it is no member of takes its name',
      {
        change: `ALTER ROLE admins RENAME TO former_admins; CREATE ROLE other; ALTER ROLE other RENAME TO admins`,
        read: READ_TASKS,
        rows: [NOTHING, NOTHING],
        setup: `GRANT guests TO b; ${admins('member')}`,
      },
    ],
    [
      'a role it is no member of takes the name a policy asks of, which another had',
      {
        change: SWAP_ADMINS,
        read: READ_TASKS,
        rows: [NOTHING, NOTHING],
        setup: admins('member'),
      },
    ],
    [
      'a role it is no member of is made, and its name is the one a policy asks of',
      {
        change: 'CREATE ROLE staff',
        read: READ_TASKS,
        rows: [MISSING, NOTHING],
        setup: `ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
          CREATE POLICY asks ON tasks FOR SELECT USING (pg_has_role(current_user, 'staff', 'member'));`,
      },
    ],
    [
      'its password is set',
      {
        change: "ALTER ROLE b PASSWORD 'secret'",
        read: READ_TASKS,
        rows: [IDS, IDS],
        setup: '',
      },
    ],
    [
      'a role that reads nothing is made and given to another role that reads nothing',
      {
        change: 'CREATE ROLE user_1; GRANT user_1 TO c',
        read: READ_TASKS,
        rows: [IDS, IDS],
        setup: '',
      },
    ],
  ])(
    'does not move once %s',
    async (_what, given) => {
      const outcome = await changing(given);

      expect(outcome.rows).toStrictEqual(given.rows);
      expect(outcome.moved).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

/** Whether the digest moves once `change` ran as the superuser, of a schema that `setup` made. */
async function movedBy(setup: string, change: string): Promise<boolean> {
  const pg = await opened(setup);
  const digest = new SchemaDigest(pg, RELATIONS);
  await pg.exec('SET ROLE b');
  await readNow(digest);

  await pg.exec('RESET ROLE');
  await pg.exec(change);
  await pg.exec('SET ROLE b');

  return (await readNow(digest)).changed;
}

describe("the schema's digest of the application's kinds it holds by whole rows", () => {
  it.each([
    [
      'an enum label is renamed',
      "CREATE TYPE public.mood AS ENUM ('ok', 'bad')",
      "ALTER TYPE public.mood RENAME VALUE 'ok' TO 'fine'",
    ],
    [
      'an enum label is added between two',
      "CREATE TYPE public.mood AS ENUM ('ok', 'bad')",
      "ALTER TYPE public.mood ADD VALUE 'meh' BEFORE 'bad'",
    ],
    [
      'a cast is made again with another context',
      "CREATE TYPE public.mood AS ENUM ('ok'); CREATE CAST (text AS public.mood) WITH INOUT AS ASSIGNMENT",
      'DROP CAST (text AS public.mood); CREATE CAST (text AS public.mood) WITH INOUT AS IMPLICIT',
    ],
  ])(
    'moves once %s',
    async (_what, setup, change) => {
      await expect(movedBy(setup, change)).resolves.toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

/** A table of the session's temporary schema of a name of the application's, which `b` may read. */
const SHADOWING_TABLE = `
  CREATE TEMP TABLE tasks (id text, x text); GRANT SELECT ON pg_temp.tasks TO b;
`;
/** What clears what `pg_class` and `pg_attribute` say of a relation late, or never of itself. */
const MAINTENANCE = [
  'VACUUM pg_temp.tasks',
  'ANALYZE pg_temp.tasks',
  'VACUUM (ANALYZE) pg_temp.tasks',
  'VACUUM (FREEZE) pg_temp.tasks',
  'VACUUM FULL pg_temp.tasks',
  'VACUUM',
  'ANALYZE',
];
const TRIGGER_FUNCTION = `
  CREATE FUNCTION pg_temp.tg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
`;

describe("the schema's digest of what the catalog says a relation has, or once had", () => {
  it.each([
    ['an index', 'CREATE INDEX tx ON pg_temp.tasks (x); DROP INDEX pg_temp.tx'],
    [
      'a rule',
      'CREATE RULE r AS ON INSERT TO pg_temp.tasks DO ALSO NOTHING; DROP RULE r ON pg_temp.tasks',
    ],
    [
      'a trigger',
      `${TRIGGER_FUNCTION} CREATE TRIGGER g BEFORE INSERT ON pg_temp.tasks FOR EACH ROW EXECUTE FUNCTION pg_temp.tg(); DROP TRIGGER g ON pg_temp.tasks`,
    ],
    ['a child', 'CREATE TEMP TABLE kid () INHERITS (pg_temp.tasks); DROP TABLE pg_temp.kid'],
    [
      'a column added with a default over a row',
      "INSERT INTO pg_temp.tasks VALUES ('a', 'b'); ALTER TABLE pg_temp.tasks ADD COLUMN n int DEFAULT 5",
    ],
  ])(
    'is the same after maintenance of a temporary table that had %s, and has it no more',
    async (_what, made) => {
      const pg = await opened(SHADOWING_TABLE + made);
      const digest = new SchemaDigest(pg, RELATIONS);
      await pg.exec('SET ROLE b');
      const baseline = await readNow(digest);
      const moved: string[] = [];

      for (const statement of MAINTENANCE) {
        await pg.exec('RESET ROLE');
        await pg.exec(statement);
        await pg.exec('SET ROLE b');
        const read = await readNow(digest);
        if (read.digest !== baseline.digest) {
          moved.push(statement);
        }
      }

      expect(moved).toStrictEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['a unique index is made on it', '', 'CREATE UNIQUE INDEX tu ON pg_temp.tasks (id)'],
    [
      'the unique index is dropped while a plain one stays',
      'CREATE UNIQUE INDEX tu ON pg_temp.tasks (id); CREATE INDEX tn ON pg_temp.tasks (id)',
      'DROP INDEX pg_temp.tu',
    ],
    ['a child is made of it', '', 'CREATE TEMP TABLE kid () INHERITS (pg_temp.tasks)'],
    [
      'its child is dropped',
      'CREATE TEMP TABLE kid () INHERITS (pg_temp.tasks)',
      'DROP TABLE pg_temp.kid',
    ],
    ['a rule is made on it', '', 'CREATE RULE r AS ON INSERT TO pg_temp.tasks DO ALSO NOTHING'],
  ])(
    'moves once %s, which a plan tells of a temporary table that shadows an application’s',
    async (_what, setup, change) => {
      await expect(movedBy(SHADOWING_TABLE + setup, change)).resolves.toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['a plain index is made on it', '', 'CREATE INDEX tx ON pg_temp.tasks (x)'],
    [
      'a plain index is dropped from it, and another stays',
      'CREATE INDEX tx ON pg_temp.tasks (x); CREATE INDEX ty ON pg_temp.tasks (id)',
      'DROP INDEX pg_temp.tx',
    ],
    [
      'a trigger is made on it',
      TRIGGER_FUNCTION,
      'CREATE TRIGGER g BEFORE INSERT ON pg_temp.tasks FOR EACH ROW EXECUTE FUNCTION pg_temp.tg()',
    ],
  ])(
    'does not move once %s, which no statement that reads it tells',
    async (_what, setup, change) => {
      await expect(movedBy(SHADOWING_TABLE + setup, change)).resolves.toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
