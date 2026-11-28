import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished } from 'vitest';

import { followDrizzle } from '../src/sql/index.ts';

/**
 * Who writes a followed table needs no right to its log: the functions the triggers run write it as
 * the role that made it, and that role alone may execute what writes the log. The roles of these
 * rows: `migrator`, which makes the table and the log and is no superuser; `app`, which writes the
 * table and has no right to the log's schema; `reader`, which may use the log's schema and read its
 * entries and its head, as a host that only reads the log; `other`, which may use the log's schema
 * and create a table of its own; and `tabler`, which may use the log's schema and make triggers on
 * the followed table.
 */

const items = pgTable('items', { id: text().primaryKey(), label: text() });
const follow = followDrizzle({ items });
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 30_000;

/** The triggers' functions, which a writer's statement or its commit enters. */
const ENTERED = [
  'capture_all',
  'capture_deleted',
  'capture_inserted',
  'capture_updated',
  'settle',
] as const;
/** What those call, of the log's own. */
const CALLED = ['hold', 'image_sql', 'note'] as const;
/** The functions of the log's that write it, in the order of their names: its role's alone to execute. */
const WRITERS = [...ENTERED, ...CALLED].toSorted((one, other) => one.localeCompare(other));

/** The statement of a trigger of `public.mine` that runs the function of the capture of rows inserted. */
function attach(name: string): string {
  return `CREATE TRIGGER ${name} AFTER INSERT ON public.mine REFERENCING NEW TABLE AS rows_after FOR EACH STATEMENT EXECUTE FUNCTION reactive_state.capture_inserted('id')`;
}

/** The digest of a key's text, as the log keeps it. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** An entry of the log: the table it names, and of a row its side and its image. */
interface Entry {
  readonly table: string;
  readonly side: string | null;
  readonly image: unknown;
}

interface Opened {
  readonly pg: PGlite;
  /** Runs `statements` as `role`, and the role is the superuser again after it. */
  readonly as: (role: string, statements: string) => Promise<void>;
  readonly entries: () => Promise<readonly Entry[]>;
}

/** Runs the statements of the capture as `migrator`, which made the log. */
async function install(pg: PGlite): Promise<void> {
  await pg.exec('SET ROLE migrator');
  try {
    for (const statement of follow.captureSql()) {
      await pg.query(statement);
    }
  } finally {
    await pg.exec('RESET ROLE');
  }
}

/**
 * The table and its log, made by `migrator`, and the roles that write or read; `before` runs first,
 * and `after` once the log is made, as the superuser.
 */
async function opened(before = '', after = ''): Promise<Opened> {
  const pg = await PGlite.create();
  onTestFinished(async () => {
    await pg.close();
  });
  await pg.exec(`
    CREATE ROLE migrator;
    CREATE ROLE app;
    CREATE ROLE reader;
    CREATE ROLE other;
    CREATE ROLE tabler;
    GRANT CREATE ON DATABASE postgres TO migrator;
    GRANT CREATE ON SCHEMA public TO migrator, other;
    ${before}
    SET ROLE migrator;
    CREATE TABLE public.items (id text PRIMARY KEY, label text);
    RESET ROLE;
  `);
  await install(pg);
  await pg.exec(`
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.items TO app;
    GRANT USAGE ON SCHEMA reactive_state TO reader, other, tabler;
    GRANT SELECT ON reactive_state.changes, reactive_state.head TO reader;
    GRANT TRIGGER ON public.items TO tabler;
    ${after}
  `);
  return {
    as: async (role, statements) => {
      await pg.exec(`SET ROLE ${role}`);
      try {
        await pg.exec(statements);
      } finally {
        await pg.exec('RESET ROLE');
      }
    },
    entries: async () => {
      const { rows } = await pg.query<Entry>(
        'SELECT table_name AS "table", side, image FROM reactive_state.changes ORDER BY seq',
      );
      return rows;
    },
    pg,
  };
}

/** The triggers' functions as an installation made before left them: executable by `PUBLIC`. */
const MADE_BEFORE = ENTERED.map(
  (name) => `GRANT EXECUTE ON FUNCTION reactive_state.${name}() TO PUBLIC;`,
).join(' ');

/** What each of two setups makes of the same writes: the default privileges of the database as they are, and taken from `PUBLIC`. */
const SETUPS: readonly (readonly [string, string])[] = [
  ['the database default privileges', ''],
  [
    'default privileges that take EXECUTE from PUBLIC',
    'ALTER DEFAULT PRIVILEGES FOR ROLE migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
  ],
];

describe.each(SETUPS)(
  'a role with no right to the log writes a followed table, with %s',
  (_name, before) => {
    it(
      'logs an insert, an update and a delete of rows, as the rows it wrote',
      async () => {
        const { as, entries } = await opened(before);

        await as('app', "INSERT INTO items VALUES ('a', 'x')");
        await as('app', "UPDATE items SET label = 'y' WHERE id = 'a'");
        await as('app', "DELETE FROM items WHERE id = 'a'");

        const logged = await entries();

        expect(logged.map((entry) => entry.side)).toStrictEqual([
          'after',
          'before',
          'after',
          'before',
        ]);
        expect(logged.map((entry) => entry.image)).toStrictEqual(
          logged.map(() => ({ id: digest('a') })),
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'logs a statement of more rows than it keeps entries of, and a truncate, as the table',
      async () => {
        const { as, entries } = await opened(before);

        await as('app', "INSERT INTO items SELECT 'k' || g, 'x' FROM generate_series(1, 150) AS g");
        await as('app', 'TRUNCATE items');

        await expect(entries()).resolves.toStrictEqual([
          { image: null, side: null, table: 'items' },
          { image: null, side: null, table: 'items' },
        ]);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

describe('the functions that write the log', { timeout: TEST_TIMEOUT_MS }, () => {
  it('are of the role that made the log, of a search path of the catalog and the temporary schema alone, and those a writer enters run as that role', async () => {
    const { pg } = await opened();

    const { rows } = await pg.query<{
      name: string;
      owner: string;
      definer: boolean;
      config: readonly string[];
    }>(
      `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config
       FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
       WHERE n.nspname = 'reactive_state' AND p.proname = ANY($1)
       ORDER BY p.proname`,
      [WRITERS],
    );

    expect(rows.map((row) => [row.name, row.owner, row.config])).toStrictEqual(
      WRITERS.map((name) => [name, 'migrator', ['search_path=pg_catalog, pg_temp']]),
    );
    expect(rows.filter((row) => row.definer).map((row) => row.name)).toStrictEqual([...ENTERED]);
  });

  it('are called by the role that made the log, and by none that may merely use its schema', async () => {
    const { as, entries } = await opened();

    await as('migrator', "SELECT reactive_state.note('public', 'items')");

    await expect(as('reader', "SELECT reactive_state.note('public', 'items')")).rejects.toThrow(
      'permission denied for function note',
    );
    await expect(as('app', "SELECT reactive_state.note('public', 'items')")).rejects.toThrow(
      'permission denied for schema reactive_state',
    );
    await expect(entries()).resolves.toHaveLength(1);
  });

  it('are executable by the role that made the log alone, no trigger function by `PUBLIC` either', async () => {
    const { pg } = await opened();

    const { rows } = await pg.query<{ name: string; owner: boolean; others: boolean }>(
      `SELECT p.proname AS name, has_function_privilege('migrator', p.oid, 'EXECUTE') AS owner, has_function_privilege('other', p.oid, 'EXECUTE') AS others
       FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
       WHERE n.nspname = 'reactive_state' AND p.proname = ANY($1)
       ORDER BY p.proname`,
      [WRITERS],
    );

    expect(rows.map((row) => [row.name, row.owner, row.others])).toStrictEqual(
      WRITERS.map((name) => [name, true, false]),
    );
  });

  it('are attached to no table by a role that may create one', async () => {
    const { as } = await opened();
    await as(
      'other',
      'CREATE TABLE public.mine (id text PRIMARY KEY, secret text, stage smallint)',
    );

    for (const [kind, event, images, run] of [
      [
        '',
        'INSERT',
        'REFERENCING NEW TABLE AS rows_after FOR EACH STATEMENT',
        "capture_inserted('id', 'secret')",
      ],
      [
        '',
        'DELETE',
        'REFERENCING OLD TABLE AS rows_before FOR EACH STATEMENT',
        "capture_deleted('id', 'secret')",
      ],
      [
        '',
        'UPDATE',
        'REFERENCING OLD TABLE AS rows_before NEW TABLE AS rows_after FOR EACH STATEMENT',
        "capture_updated('id', 'secret')",
      ],
      ['', 'TRUNCATE', 'FOR EACH STATEMENT', 'capture_all()'],
      ['CONSTRAINT', 'INSERT', 'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW', 'settle()'],
    ] as const) {
      await expect(
        as(
          'other',
          `CREATE ${kind} TRIGGER mine AFTER ${event} ON public.mine ${images} EXECUTE FUNCTION reactive_state.${run}`,
        ),
      ).rejects.toThrow('permission denied for function');
    }
  });

  it('log the rows a policy of the table lets the writer change, and none it hides', async () => {
    const { as, entries, pg } = await opened();
    await pg.exec(`
      INSERT INTO items VALUES ('mine', 'a'), ('theirs', 'b');
      ALTER TABLE items ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own ON items FOR ALL TO app USING (id = 'mine') WITH CHECK (id = 'mine');
    `);
    const before = await entries();

    await as('app', "UPDATE items SET label = 'z'");

    const after = await entries();

    expect(after.slice(before.length).map((entry) => entry.image)).toStrictEqual([
      { id: digest('mine') },
      { id: digest('mine') },
    ]);
    expect(JSON.stringify(after.slice(before.length))).not.toContain(digest('theirs'));
  });

  it('reach an installation made before, which installs the capture again, and leave a trigger another role attached before as it is', async () => {
    const { as, entries, pg } = await opened('', MADE_BEFORE);
    await as('other', 'CREATE TABLE public.mine (id text PRIMARY KEY)');
    await as('other', attach('before_installing_again'));

    await install(pg);
    await as('app', "INSERT INTO items VALUES ('a', 'x')");

    await expect(entries()).resolves.toStrictEqual([
      { image: { id: digest('a') }, side: 'after', table: 'items' },
    ]);
    await expect(as('reader', "SELECT reactive_state.note('public', 'items')")).rejects.toThrow(
      'permission denied for function note',
    );
    await expect(as('other', attach('after_installing_again'))).rejects.toThrow(
      'permission denied for function',
    );

    // The right is asked as a trigger is made, not as it fires: one made before fires on.
    await as('other', "INSERT INTO public.mine VALUES ('m')");

    await expect(entries()).resolves.toHaveLength(2);
  });

  it('are run as before by the superuser', async () => {
    const { entries, pg } = await opened();

    await pg.query("INSERT INTO items VALUES ('a', 'x')");

    await expect(entries()).resolves.toHaveLength(1);
  });
});

describe('a role that did not make the log', { timeout: TEST_TIMEOUT_MS }, () => {
  it('reads it, and prunes it, by the right to use its schema and to read its entries and its head alone', async () => {
    const { as, pg } = await opened();
    await as('app', "INSERT INTO items VALUES ('a', 'x')");
    await pg.exec('SET ROLE reader');

    const read = await follow.store(pg).changes(0, 10);
    await follow.prune(pg, Date.now() + 60_000);
    const pruned = await follow.store(pg).changes(0, 10);

    expect(read.changes).toHaveLength(1);
    expect(pruned).toMatchObject({ changes: [], floor: 2, head: 1 });
  });

  it('finds the triggers of a followed table standing, by the right to use the schema alone', async () => {
    const { as } = await opened();
    const [, table = ''] = follow.captureSql();

    await expect(as('reader', table)).resolves.toBeUndefined();
  });

  it('makes no trigger a followed table lacks, though it may make triggers on the table', async () => {
    const { as, entries, pg } = await opened();
    const [, table = ''] = follow.captureSql();
    await pg.exec('DROP TRIGGER reactive_state_insert ON public.items');

    await expect(as('tabler', table)).rejects.toThrow(
      'permission denied for function reactive_state.capture_inserted',
    );

    await install(pg);
    await as('app', "INSERT INTO items VALUES ('a', 'x')");

    await expect(entries()).resolves.toHaveLength(1);
  });

  it('makes nothing of the log, whose statement PostgreSQL refuses whole at the first function it would replace', async () => {
    const { as, pg } = await opened(
      'CREATE ROLE second; GRANT CREATE ON DATABASE postgres TO second;',
      `GRANT USAGE, CREATE ON SCHEMA reactive_state TO second;
       GRANT ALL ON ALL TABLES IN SCHEMA reactive_state TO second;
       GRANT ALL ON ALL SEQUENCES IN SCHEMA reactive_state TO second;`,
    );
    const [log = ''] = follow.captureSql();
    const owned = async (): Promise<readonly string[]> => {
      const { rows } = await pg.query<{ owner: string }>(
        `SELECT DISTINCT pg_get_userbyid(p.proowner) AS owner FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'reactive_state'`,
      );
      return rows.map((row) => row.owner);
    };

    await expect(as('second', log)).rejects.toMatchObject({
      code: '42501',
      message: 'must be owner of function image_sql',
    });
    await expect(as('reader', log)).rejects.toMatchObject({ code: '42501' });
    await expect(owned()).resolves.toStrictEqual(['migrator']);
  });
});
