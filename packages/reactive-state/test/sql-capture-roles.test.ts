import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';

import { changeCaptureSql } from '../src/sql/capture.ts';

/**
 * Who writes a followed table needs no right to its log: the functions the triggers run write it as
 * the role that made it. The roles of these rows: `migrator`, which makes the table and the log and
 * is no superuser; `app`, which writes the table and has no right to the log's schema; `reader`,
 * which may use the log's schema; and `other`, which may create a table of its own.
 */

const RELATIONS = [{ keys: ['id'], name: 'items', schema: 'public' }];
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 30_000;

/** The digest of a key's text, as the log keeps it. */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface Opened {
  readonly pg: PGlite;
  /** Runs `text` as `role`, and the role is the superuser again after it. */
  readonly as: (role: string, text: string) => Promise<void>;
  readonly log: () => Promise<{
    readonly head: number;
    readonly entries: readonly { readonly side: string | null; readonly image: unknown }[];
  }>;
}

/** The statements of the capture as an installation made before the functions were definers ran them. */
function beforeDefiners(statement: string): string | undefined {
  if (statement.startsWith('REVOKE EXECUTE ON FUNCTION')) {
    return undefined;
  }
  return /^CREATE OR REPLACE FUNCTION "reactive_state"\."(?:capture_\w+|note)"\(/u.test(statement)
    ? statement.replace(' SECURITY DEFINER', '')
    : statement;
}

/**
 * The table and its log, made by `migrator`, and the roles that write or read; `before` runs first,
 * and `install` says what each statement of the capture is run as, or that it is not.
 */
async function opened(
  before = '',
  install: (statement: string) => string | undefined = (statement) => statement,
): Promise<Opened> {
  const pg = await PGlite.create();
  onTestFinished(async () => {
    await pg.close();
  });
  await pg.exec(`
    CREATE ROLE migrator;
    CREATE ROLE app;
    CREATE ROLE reader;
    CREATE ROLE other;
    GRANT CREATE ON DATABASE postgres TO migrator;
    GRANT CREATE ON SCHEMA public TO migrator, other;
    ${before}
    SET ROLE migrator;
    CREATE TABLE public.items (id text PRIMARY KEY, label text);
  `);
  for (const statement of changeCaptureSql(RELATIONS)) {
    const run = install(statement);
    if (run !== undefined) {
      await pg.query(run);
    }
  }
  await pg.exec(`
    RESET ROLE;
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.items TO app;
    GRANT USAGE ON SCHEMA reactive_state TO reader, other;
  `);
  return {
    as: async (role, text) => {
      await pg.exec(`SET ROLE ${role}`);
      try {
        await pg.exec(text);
      } finally {
        await pg.exec('RESET ROLE');
      }
    },
    log: async () => {
      const head = await pg.query<{ seq: string }>('SELECT seq FROM reactive_state.head');
      const entries = await pg.query<{ side: string | null; image: unknown }>(
        'SELECT side, image FROM reactive_state.changes ORDER BY seq',
      );
      return { entries: entries.rows, head: Number(head.rows[0]?.seq) };
    },
    pg,
  };
}

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
        const { as, log } = await opened(before);

        await as('app', "INSERT INTO items VALUES ('a', 'x')");
        await as('app', "UPDATE items SET label = 'y' WHERE id = 'a'");
        await as('app', "DELETE FROM items WHERE id = 'a'");

        const { entries, head } = await log();

        expect(head).toBe(4);
        expect(entries.map((entry) => entry.side)).toStrictEqual([
          'after',
          'before',
          'after',
          'before',
        ]);
        expect(
          entries.every(
            (entry) => JSON.stringify(entry.image) === JSON.stringify({ id: digest('a') }),
          ),
        ).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'logs a statement of more rows than it keeps entries of, and a truncate, as the table',
      async () => {
        const { as, log } = await opened(before);

        await as('app', "INSERT INTO items SELECT 'k' || g, 'x' FROM generate_series(1, 150) AS g");
        await as('app', 'TRUNCATE items');

        const { entries, head } = await log();

        expect(head).toBe(2);
        expect(entries.map((entry) => entry.image)).toStrictEqual([null, null]);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

describe('the functions that write the log', { timeout: TEST_TIMEOUT_MS }, () => {
  it('run as the role that made the log, of a search path of the catalog and the temporary schema alone', async () => {
    const { pg } = await opened();

    const { rows } = await pg.query<{
      name: string;
      owner: string;
      definer: boolean;
      config: readonly string[];
    }>(`
      SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config
      FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'reactive_state' AND p.proname IN ('capture_all', 'capture_deleted', 'capture_inserted', 'capture_updated', 'note')
      ORDER BY p.proname
    `);

    expect(rows.map((row) => [row.name, row.owner, row.definer, row.config])).toStrictEqual(
      ['capture_all', 'capture_deleted', 'capture_inserted', 'capture_updated', 'note'].map(
        (name) => [name, 'migrator', true, ['search_path=pg_catalog, pg_temp']],
      ),
    );
  });

  it('are called by the role that made the log, and by none that may merely use its schema', async () => {
    const { as, log } = await opened();

    await as('migrator', "SELECT reactive_state.note('public', 'items')");

    await expect(as('reader', "SELECT reactive_state.note('public', 'items')")).rejects.toThrow(
      'permission denied for function note',
    );
    await expect(as('app', "SELECT reactive_state.note('public', 'items')")).rejects.toThrow(
      'permission denied for schema reactive_state',
    );
    expect((await log()).head).toBe(1);
  });

  it("write the digests of a row's keys alone, of a table a role that may create one attaches them to", async () => {
    const { as, log } = await opened();

    await as(
      'other',
      `CREATE TABLE public.mine (id text PRIMARY KEY, secret text);
       CREATE TRIGGER mine AFTER INSERT ON public.mine REFERENCING NEW TABLE AS rows_after FOR EACH STATEMENT EXECUTE FUNCTION reactive_state.capture_inserted('id', 'secret', 'absent')`,
    );
    await as('other', "INSERT INTO mine VALUES ('i', 'confidential')");

    const { entries } = await log();

    expect(entries.map((entry) => entry.image)).toStrictEqual([
      { id: digest('i'), secret: digest('confidential') },
    ]);
  });

  it('log the rows a policy of the table lets the writer change, and none it hides', async () => {
    const { as, log, pg } = await opened();
    await pg.exec(`
      INSERT INTO items VALUES ('mine', 'a'), ('theirs', 'b');
      ALTER TABLE items ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own ON items FOR ALL TO app USING (id = 'mine') WITH CHECK (id = 'mine');
    `);
    const { head } = await log();

    await as('app', "UPDATE items SET label = 'z'");

    const after = await log();

    expect(after.head).toBe(head + 2);
    expect(after.entries.slice(-2).map((entry) => entry.image)).toStrictEqual([
      { id: digest('mine') },
      { id: digest('mine') },
    ]);
    expect(JSON.stringify(after.entries.slice(-2))).not.toContain(digest('theirs'));
  });

  it('reach an installation made before, which installs the capture again', async () => {
    const { as, log, pg } = await opened('', beforeDefiners);

    await expect(as('app', "INSERT INTO items VALUES ('a', 'x')")).rejects.toThrow(
      'permission denied for schema reactive_state',
    );

    await pg.exec('SET ROLE migrator');
    for (const statement of changeCaptureSql(RELATIONS)) {
      await pg.query(statement);
    }
    await pg.exec('RESET ROLE');
    await as('app', "INSERT INTO items VALUES ('a', 'x')");

    expect((await log()).head).toBe(1);
    await expect(as('reader', "SELECT reactive_state.note('public', 'items')")).rejects.toThrow(
      'permission denied for function note',
    );
  });

  it('are run as before by the superuser', async () => {
    const { log, pg } = await opened();

    await pg.query("INSERT INTO items VALUES ('a', 'x')");

    expect((await log()).head).toBe(1);
  });
});
