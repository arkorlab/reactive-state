import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { Json, RenderScope } from '../src/program.ts';
import { catalogOf } from '../src/sql/catalog.ts';
import type { Followed } from '../src/sql/keys.ts';
import { engineOf, openedWith } from './support/drizzle.ts';

/**
 * A table that inherits from another (`INHERITS`) is no table the log follows: a write through its
 * parent changes its rows, and the log names the parent. A render that reads the child is refused,
 * whichever of the tables the schema declares; the parent's own rows (`ONLY`) are read as before.
 */

const base = pgTable('base', { id: text().primaryKey(), kind: text().notNull() });
const child = pgTable('child', { id: text().primaryKey(), kind: text().notNull(), extra: text() });
const grandchild = pgTable('grandchild', {
  id: text().primaryKey(),
  kind: text().notNull(),
  extra: text(),
});
const INHERITED = `
  CREATE TABLE base (id text PRIMARY KEY, kind text NOT NULL);
  CREATE TABLE child (extra text) INHERITS (base);
  CREATE TABLE grandchild () INHERITS (child);
  INSERT INTO base VALUES ('a', 'x');
  INSERT INTO child VALUES ('c', 'y', 'z');
  INSERT INTO grandchild VALUES ('g', 'w', 'v');
`;
const REFUSED = 'does not follow inheritance';
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;

/** A render that reads `statement`'s rows as text. */
function reading(setup: Awaited<ReturnType<typeof openedWith>>, statement: string) {
  return vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
    const rows = await setup.orm.execute(sql.raw(statement));
    return $.h('p', null, JSON.stringify(rows.rows.map((row) => [row['id'], row['kind']])));
  });
}

describe(
  'a render that reads a table that inherits from another',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it.each([
      ['beside its parent', { base, child }],
      ['alone', { child }],
    ])(
      'is refused where the schema declares it %s, not served what a write through the parent changes',
      async (_name, declared) => {
        const setup = await openedWith(declared, INHERITED);
        const { engine, render } = await engineOf(
          setup,
          reading(setup, 'SELECT id, kind FROM child ORDER BY id'),
        );

        await expect(render()).rejects.toThrow(REFUSED);

        await setup.pg.exec(`UPDATE base SET kind = 'new' WHERE id = 'c'`);
        await engine.poke();

        await expect(render()).rejects.toThrow(REFUSED);
      },
    );

    it('is refused where it inherits at a second depth', async () => {
      const setup = await openedWith({ child, grandchild }, INHERITED);
      const { render } = await engineOf(
        setup,
        reading(setup, 'SELECT id, kind FROM grandchild ORDER BY id'),
      );

      await expect(render()).rejects.toThrow(REFUSED);
    });

    it.each([
      ['declares them', { base, child, grandchild }],
      ['declares the parent alone', { base }],
    ])(
      'is refused where a render reads the parent whole, as the schema %s',
      async (_name, declared) => {
        const setup = await openedWith(declared, INHERITED);
        const { render } = await engineOf(
          setup,
          reading(setup, 'SELECT id, kind FROM base ORDER BY id'),
        );

        await expect(render()).rejects.toThrow(REFUSED);
      },
    );

    it('is refused where it is read beside an ordinary table in one render, whichever statement is asked first', async () => {
      const plain = pgTable('plain', { id: text().primaryKey() });
      const setup = await openedWith(
        { child, plain },
        `${INHERITED} CREATE TABLE plain (id text PRIMARY KEY);`,
      );
      const { render } = await engineOf(setup, async (_props, $) => {
        const [ordinary, inherited] = await Promise.all([
          setup.orm.execute(sql`SELECT id FROM plain`),
          setup.orm.execute(sql`SELECT id FROM child`),
        ]);
        return $.h('p', null, JSON.stringify([ordinary.rows.length, inherited.rows.length]));
      });

      await expect(render()).rejects.toThrow(REFUSED);
    });
  },
);

describe(
  'what the tables that inherit beside a table leave as it was',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it('renders again what read the parent`s own rows alone, as a write to them changes, and not as one to a child does', async () => {
      const setup = await openedWith({ base, child }, INHERITED);
      const evaluate = reading(setup, 'SELECT id, kind FROM ONLY base ORDER BY id');
      const { engine, render } = await engineOf(setup, evaluate);

      await expect(render()).resolves.toBe('[["a","x"]]');

      await setup.pg.exec(`UPDATE child SET kind = 'new' WHERE id = 'c'`);
      await engine.poke();

      await expect(render()).resolves.toBe('[["a","x"]]');
      expect(evaluate).toHaveBeenCalledTimes(1);

      await setup.pg.exec(`UPDATE base SET kind = 'new' WHERE id = 'a'`);
      await engine.poke();

      await expect(render()).resolves.toBe('[["a","new"]]');
      expect(evaluate).toHaveBeenCalledTimes(2);
    });

    it('renders again what read a table nothing inherits from, beside tables that do', async () => {
      const plain = pgTable('plain', { id: text().primaryKey() });
      const setup = await openedWith(
        { base, child, plain },
        `${INHERITED} CREATE TABLE plain (id text PRIMARY KEY); INSERT INTO plain VALUES ('p');`,
      );
      const evaluate = reading(setup, 'SELECT id, id AS kind FROM plain ORDER BY id');
      const { engine, render } = await engineOf(setup, evaluate);

      await expect(render()).resolves.toBe('[["p","p"]]');

      await setup.pg.exec(`INSERT INTO plain VALUES ('q')`);
      await engine.poke();

      await expect(render()).resolves.toBe('[["p","p"],["q","q"]]');
      expect(evaluate).toHaveBeenCalledTimes(2);
    });
  },
);

/** The followed tables of the rows below: a parent and the tables that inherit, and a partition. */
const followed: Followed = {
  byRelation: new Map([
    ['public.base', 'base'],
    ['public.child', 'child'],
  ]),
  keysByTable: new Map([
    ['base', [{ column: 'id', field: 'k_id', kind: 'text' }]],
    ['child', [{ column: 'id', field: 'k_id', kind: 'text' }]],
  ]),
  namespace: 'reactive_state',
  relations: [
    { name: 'base', schema: 'public' },
    { name: 'child', schema: 'public' },
  ],
  schema: { generation: 0 },
  schemaTable: 'reactive_state_schema_sql',
};

/** A table as the catalog says it, with no column. */
function catalogTable(name: string, kind: string, partition: boolean, inherits: boolean) {
  return { columns: [], hidden: false, inherits, kind, name, partition, schema: 'public' };
}

const TABLES = [
  catalogTable('base', 'r', false, false),
  catalogTable('child', 'r', false, true),
  catalogTable('grandchild', 'r', false, true),
  catalogTable('parted', 'p', false, false),
  catalogTable('parted_eu', 'r', true, true),
];

describe('which tables the catalog says inherit from another', () => {
  it.each<readonly [string, Record<string, unknown>]>([
    ['a catalog that follows conditions', { operators: false, utf8: true, version: 180_000 }],
    ['a PostgreSQL before 17', { operators: false, version: 160_004 }],
    ['an application `=` of a type a key may be', { operators: true, version: 180_000 }],
  ])(
    'names the tables that inherit, and neither their parent nor a partition: %s',
    (_name, facts) => {
      const catalog = catalogOf([{ ...facts, tables: TABLES }], followed);

      expect(catalog.inherited).toStrictEqual(new Set(['public.child', 'public.grandchild']));
      expect(catalog.partitioned).toStrictEqual(new Set(['public.parted', 'public.parted_eu']));
    },
  );

  it('names none where no table inherits, and where the catalog is not known', () => {
    const ordinary = [catalogTable('base', 'r', false, false)];

    expect(
      catalogOf([{ operators: false, tables: ordinary, version: 180_000 }], followed).inherited,
    ).toStrictEqual(new Set());
    expect(catalogOf([{ operators: false, version: 180_000 }], followed).inherited).toStrictEqual(
      new Set(),
    );
  });
});
