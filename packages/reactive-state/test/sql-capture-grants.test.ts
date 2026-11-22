import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';

import { changeCaptureSql } from '../src/sql/capture.ts';

/**
 * The functions of the capture that only the role that made the log may execute are executable by no
 * other role the function's ACL names: not `PUBLIC`, not a role the installer's default privileges
 * name for functions, not one granted it since (which `CREATE OR REPLACE` keeps), and not one that a
 * role with the grant option granted it. The roles of these rows: `migrator`, which makes the table
 * and the log and is no superuser; `app`, `mid`, `leaf`, which may use the log's schema; and
 * `member`, a member of `migrator`.
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
const NAMES = Object.keys(RESTRICTED);
/** The ACL of a function only its owner may execute. */
const OWNER_ONLY = '{migrator=X/migrator}';

/** A PGlite whose log's schema was made, and `app`, `mid` and `leaf` may use, before the install. */
async function opened(before: string): Promise<PGlite> {
  const pg = await PGlite.create();
  onTestFinished(async () => {
    await pg.close();
  });
  await pg.exec(`
    CREATE ROLE migrator; CREATE ROLE app; CREATE ROLE mid; CREATE ROLE leaf; CREATE ROLE member;
    GRANT migrator TO member;
    GRANT CREATE ON DATABASE postgres TO migrator;
    GRANT CREATE ON SCHEMA public TO migrator, app;
    CREATE SCHEMA reactive_state AUTHORIZATION migrator;
    GRANT USAGE ON SCHEMA reactive_state TO app, mid, leaf, member;
    ${before}
    SET ROLE migrator;
    CREATE TABLE public.items (id text PRIMARY KEY, label text);
  `);
  return pg;
}

/** Which of the five functions that exist `roles` may execute, by `role:function`. */
async function executable(pg: PGlite, roles: readonly string[]): Promise<readonly string[]> {
  const { rows } = await pg.query<{ pair: string }>(
    `SELECT r.name || ':' || p.proname AS pair
     FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
     CROSS JOIN unnest($2::text[]) AS r(name)
     WHERE n.nspname = 'reactive_state' AND p.proname = ANY($1)
       AND has_function_privilege(r.name, p.oid, 'EXECUTE')
     ORDER BY 1`,
    [NAMES, roles],
  );
  return rows.map((row) => row.pair);
}

/** The install, run as it is, after each statement of which `check` is asked what is still open. */
async function installing(
  pg: PGlite,
  check: (made: ReadonlySet<string>) => Promise<readonly string[]>,
): Promise<readonly (readonly string[])[]> {
  const made = new Set<string>();
  const seen: (readonly string[])[] = [];
  for (const statement of changeCaptureSql(RELATIONS)) {
    await pg.query(statement);
    for (const name of NAMES) {
      if (!made.has(name) && statement.includes(`."${name}"(`)) {
        made.add(name);
      }
    }
    seen.push(await check(made));
  }
  return seen;
}

/** What `role` is answered where it calls `note`: it ran, or why it did not. */
async function callsNote(pg: PGlite, role: string): Promise<string> {
  await pg.exec(`RESET ROLE; SET ROLE ${role}`);
  try {
    await pg.query("SELECT reactive_state.note('public', 'items')");
    return 'ran';
  } catch (error) {
    return String((error as { message?: unknown }).message);
  } finally {
    await pg.exec('RESET ROLE; SET ROLE migrator');
  }
}

/** The functions executable by `roles` among those the install has made so far. */
function openAmong(pg: PGlite, roles: readonly string[]) {
  return async (made: ReadonlySet<string>): Promise<readonly string[]> => {
    const open = await executable(pg, roles);
    return open.filter((pair) => made.has(pair.slice(pair.indexOf(':') + 1)));
  };
}

/** Each of the five granted to `app` explicitly, after an install made them. */
const GRANTED_TO_APP = `
  GRANT EXECUTE ON FUNCTION ${Object.values(RESTRICTED)
    .map((signature) => `reactive_state.${signature}`)
    .join(', ')} TO app;
`;
/** `signature` granted to `mid` with the grant option, which grants it on to `leaf`. */
function grantedOn(signature: string): string {
  return `
    GRANT EXECUTE ON FUNCTION reactive_state.${signature} TO mid WITH GRANT OPTION;
    SET ROLE mid; GRANT EXECUTE ON FUNCTION reactive_state.${signature} TO leaf; SET ROLE migrator;`;
}
/** Each of the five so granted. */
const GRANTED_ON = Object.values(RESTRICTED)
  .map((signature) => grantedOn(signature))
  .join('');

/** An install over one that was made and then granted `grants`, as `migrator`. */
async function installedTwice(grants: string): Promise<PGlite> {
  const pg = await opened('');
  for (const statement of changeCaptureSql(RELATIONS)) {
    await pg.query(statement);
  }
  await pg.exec(grants);
  return pg;
}

describe('the functions of the capture that only the role that made the log may execute', () => {
  it(
    'are executable by no role the installer’s default privileges name for functions, after any statement of a first install',
    async () => {
      const pg = await opened(
        'ALTER DEFAULT PRIVILEGES FOR ROLE migrator GRANT EXECUTE ON FUNCTIONS TO app;',
      );

      const seen = await installing(pg, openAmong(pg, ['app']));

      expect(seen.filter((open) => open.length > 0)).toStrictEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'are executable by no role granted them since, once an install has made them again',
    async () => {
      const pg = await installedTwice(GRANTED_TO_APP);

      const seen = await installing(pg, openAmong(pg, ['app']));

      expect(seen.filter((open) => open.length > 0)).toStrictEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'are executable by no role granted them with the grant option, nor by one it granted them on to',
    async () => {
      const pg = await installedTwice(GRANTED_ON);

      await expect(executable(pg, ['mid', 'leaf'])).resolves.toHaveLength(10);

      const seen = await installing(pg, openAmong(pg, ['mid', 'leaf']));

      expect(seen.filter((open) => open.length > 0)).toStrictEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    [
      'default privileges name a role for functions',
      async () =>
        opened('ALTER DEFAULT PRIVILEGES FOR ROLE migrator GRANT EXECUTE ON FUNCTIONS TO app;'),
    ],
    ['a role was granted `note` since', async () => installedTwice(GRANTED_TO_APP)],
  ])(
    'refuse `note` to a role that may use the log’s schema where %s, once the statement that makes it has run',
    async (_what, make) => {
      const pg = await make();
      for (const statement of changeCaptureSql(RELATIONS)) {
        await pg.query(statement);
        if (statement.includes('."note"(')) {
          break;
        }
      }

      await expect(callsNote(pg, 'app')).resolves.toBe('permission denied for function note');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'are left to the role that made the log, and to a member of it, which holds its rights, and to no entry else',
    async () => {
      const pg = await installedTwice(GRANTED_TO_APP);
      for (const statement of changeCaptureSql(RELATIONS)) {
        await pg.query(statement);
      }
      const { rows } = await pg.query<{ name: string; acl: string }>(
        `SELECT p.proname AS name, p.proacl::text AS acl FROM pg_proc AS p
         JOIN pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname = 'reactive_state' AND p.proname = ANY($1) ORDER BY 1`,
        [NAMES],
      );

      const owned = NAMES.toSorted((one, other) => one.localeCompare(other));

      expect(rows.map((row) => [row.name, row.acl])).toStrictEqual(
        owned.map((name) => [name, OWNER_ONLY]),
      );
      await expect(executable(pg, ['member'])).resolves.toHaveLength(5);
    },
    TEST_TIMEOUT_MS,
  );
});
