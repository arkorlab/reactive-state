import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { hostOf } from '../src/authority/database-host.ts';
import { startAuthority } from '../src/authority/index.ts';
import { PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import { reactiveDb } from '../src/sql/db.ts';
import { followedDb } from '../src/sql/index.ts';
import { engineOf, openedWith } from './support/drizzle.ts';
import { textOf } from './support/frames.ts';

/**
 * `db.<table>` of a table a follow declares, as a render reads it: refused whatever it asks — of an
 * id a record may have or none could, of any query, a malformed one too — for the application's
 * SQL reads the table, of a database of `followedDb`'s and of `reactiveDb`'s alike.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const cards = sqliteTable('cards', { id: sqliteText().primaryKey(), title: sqliteText() });
const BUILD = 'b_followed_reads';
const COMPONENT = 'components/reads';
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;
const environment = { file: process.env['D1_FILE'] };

/** What a database answers of a table, as `database()` makes it, whatever its type says. */
type Reads = Readonly<
  Record<
    string,
    {
      readonly get: (id: string) => Promise<unknown>;
      readonly findMany: (query: unknown) => Promise<unknown>;
      readonly count: (query: unknown) => Promise<unknown>;
    }
  >
>;

/** Each read a render asks of the followed table `table`, by what it asks. */
function readsOf(table: string): readonly (readonly [string, (db: Reads) => unknown])[] {
  return [
    ['get of an id a record may have', async (db) => db[table]?.get('t1')],
    ['get of an id no record could have', async (db) => db[table]?.get('no id')],
    ['findMany of every record', async (db) => db[table]?.findMany({ where: {} })],
    [
      'findMany of a condition no record could meet',
      async (db) => db[table]?.findMany({ where: { id: 'no id' } }),
    ],
    [
      'findMany of a field the table has none of',
      async (db) => db[table]?.findMany({ where: { nothing: 'x' } }),
    ],
    ['count', async (db) => db[table]?.count({ where: {} })],
  ];
}

/** The refusal of `db.<table>` of a followed table. */
function refusalOf(table: string): string {
  return `${table} is read by SQL: query it with the application's Drizzle, whose plan says what a render read, not through \`db.${table}\`.`;
}

describe('db.<table> of a table of followedDb', () => {
  it.each(readsOf('tasks'))('is refused: %s', { timeout: TEST_TIMEOUT_MS }, async (_, read) => {
    const setup = await openedWith(
      { tasks },
      "CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL); INSERT INTO tasks VALUES ('t1', 'one');",
    );
    const db = followedDb(setup.follow);
    const { render } = await engineOf(
      setup,
      async (_props, $) => {
        await read(db as unknown as Reads);
        return $.h('p', null, 'read');
      },
      {},
      { database: db },
    );

    await expect(render()).rejects.toThrow(refusalOf('tasks'));
  });
});

/** An authority of a database of `reactiveDb`'s, of D1's shape in memory, whose render `read` asks. */
async function reactiveRender(read: (db: Reads) => unknown): Promise<() => Promise<string>> {
  process.env['D1_FILE'] = ':memory:';
  const { db, orm } = await reactiveDb({ cards });
  onTestFinished(async () => {
    await hostOf(db)?.close();
  });
  await orm.run(sql.raw('CREATE TABLE cards (id text PRIMARY KEY, title text)'));
  await orm.run(sql.raw("INSERT INTO cards VALUES ('t1', 'one')"));
  const authority = await startAuthority({
    buildId: BUILD,
    database: db,
    programs: [
      {
        buildId: BUILD,
        component: COMPONENT,
        evaluate: async (_props, $: RenderScope) => {
          await read(db as unknown as Reads);
          return $.h('p', null, 'read');
        },
        protocolVersion: PROTOCOL_VERSION,
        updaters: {},
        writable: [],
      },
    ],
  });
  onTestFinished(() => authority.close());
  const { sessionId } = await authority.engine.login('alice');
  const root = { build: BUILD, component: COMPONENT, props: {} };
  return async () => textOf((await authority.engine.render(sessionId, root)).tree);
}

describe('db.<table> of a table of reactiveDb', () => {
  beforeEach(() => {
    delete process.env['DATABASE_URL'];
  });

  afterEach(() => {
    if (environment.file === undefined) delete process.env['D1_FILE'];
    else process.env['D1_FILE'] = environment.file;
  });

  it.each(readsOf('cards'))('is refused: %s', { timeout: TEST_TIMEOUT_MS }, async (_, read) => {
    const render = await reactiveRender(read);

    await expect(render()).rejects.toThrow(refusalOf('cards'));
  });
});
