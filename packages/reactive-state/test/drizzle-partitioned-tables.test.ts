import { setTimeout as sleep } from 'node:timers/promises';

import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { Json, RenderScope } from '../src/program.ts';
import { catalogOf, NO_CONDITIONS } from '../src/sql/catalog.ts';
import type { Followed } from '../src/sql/keys.ts';
import { engineOf, openedWith } from './support/drizzle.ts';

/**
 * A partitioned table is no table the log follows: a plan names its partitions, and a write to it is
 * logged as the table's, never as a partition's. A render that reads one is refused, whichever of the
 * table and its partitions the schema declares, and not served a read no write renders again.
 */

const parted = pgTable('parted', { id: text().notNull(), region: text().notNull() });
const partedEu = pgTable('parted_eu', { id: text().notNull(), region: text().notNull() });
const partedUs = pgTable('parted_us', { id: text().notNull(), region: text().notNull() });
const plain = pgTable('plain', { id: text().primaryKey() });
const PARTITIONED = `
  CREATE TABLE parted (id text, region text NOT NULL, PRIMARY KEY (id, region)) PARTITION BY LIST (region);
  CREATE TABLE parted_eu PARTITION OF parted FOR VALUES IN ('eu');
  CREATE TABLE parted_us PARTITION OF parted FOR VALUES IN ('us');
  CREATE TABLE plain (id text PRIMARY KEY);
  INSERT INTO parted VALUES ('a', 'eu');
  INSERT INTO plain VALUES ('p');
`;
const REFUSED = 'does not follow partitioned tables';
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;

/** How long a held answer waits once the statement beside it has been answered: a render's microtasks fit in it. */
const HELD_MS = 20;
/** What the statement that asks the catalog begins with. */
const CATALOG = "SELECT current_setting('server_version_num')";

/**
 * Holds the answer of the first statement that carries the catalog until the next that `pg` runs has
 * been answered and its render has gone on, as a connection that answers out of turn would.
 */
function catalogLast(pg: PGlite): void {
  const exec = pg.exec.bind(pg);
  const held = Promise.withResolvers<undefined>();
  let asked = false;
  vi.spyOn(pg, 'exec').mockImplementation(async (statement, options) => {
    const answered = exec(statement, options);
    if (!asked && statement.startsWith(CATALOG)) {
      asked = true;
      const results = await answered;
      await held.promise;
      await sleep(HELD_MS);
      return results;
    }
    if (asked) {
      try {
        return await answered;
      } finally {
        held.resolve(undefined);
      }
    }
    return answered;
  });
}

/** Whether `statement` ran, for a render that goes on where it failed. */
async function ranOrFailed(statement: PromiseLike<unknown>): Promise<'failed' | 'ran'> {
  try {
    await statement;
    return 'ran';
  } catch {
    return 'failed';
  }
}

/** A render that reads `statement`'s rows as text. */
function reading(setup: Awaited<ReturnType<typeof openedWith>>, statement: ReturnType<typeof sql>) {
  return vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
    const rows = await setup.orm.execute(statement);
    return $.h('p', null, JSON.stringify(rows.rows.map((row) => row['id'])));
  });
}

describe('a render that reads a partitioned table', { timeout: TEST_TIMEOUT_MS }, () => {
  it('is refused where the schema declares the table alone, as no partition is followed', async () => {
    const setup = await openedWith({ parted }, PARTITIONED);
    const { render } = await engineOf(setup, reading(setup, sql`SELECT id FROM parted`));

    await expect(render()).rejects.toThrow(REFUSED);
  });

  it('is refused where the schema declares the partitions too, not served a read no write renders again', async () => {
    const setup = await openedWith({ parted, partedEu }, PARTITIONED);
    const evaluate = reading(setup, sql`SELECT id FROM parted ORDER BY id`);
    const { engine, render } = await engineOf(setup, evaluate);

    await expect(render()).rejects.toThrow(REFUSED);

    await setup.orm.insert(parted).values({ id: 'b', region: 'eu' });
    await engine.poke();

    await expect(render()).rejects.toThrow(REFUSED);
  });

  it('is refused where it reads a partition directly, declared or not', async () => {
    const declaredAlone = await openedWith({ partedEu }, PARTITIONED);
    const alone = await engineOf(
      declaredAlone,
      reading(declaredAlone, sql`SELECT id FROM parted_eu`),
    );

    await expect(alone.render()).rejects.toThrow(REFUSED);

    const ofDeclaredTable = await openedWith({ parted }, PARTITIONED);
    const direct = await engineOf(
      ofDeclaredTable,
      reading(ofDeclaredTable, sql`SELECT id FROM parted_eu`),
    );

    await expect(direct.render()).rejects.toThrow(REFUSED);
  });

  it('is refused where it is read beside an ordinary table in one render, whichever statement is asked first', async () => {
    const setup = await openedWith({ parted, plain }, PARTITIONED);
    const { render } = await engineOf(setup, async (_props, $) => {
      const [ordinary, partitioned] = await Promise.all([
        setup.orm.execute(sql`SELECT id FROM plain`),
        setup.orm.execute(sql`SELECT id FROM parted`),
      ]);
      return $.h('p', null, JSON.stringify([ordinary.rows.length, partitioned.rows.length]));
    });

    await expect(render()).rejects.toThrow(REFUSED);
  });

  it.each([
    ['the ordinary table', 'plain'],
    ['the partitioned table', 'parted'],
  ] as const)(
    'is refused where the catalog is answered after the statement beside it, which asked it first for %s',
    async (_name, first) => {
      const setup = await openedWith({ parted, partedEu, partedUs, plain }, PARTITIONED);
      catalogLast(setup.pg);
      const { render } = await engineOf(setup, async (_props, $) => {
        const reads = [
          () => setup.orm.execute(sql`SELECT id FROM plain`),
          () => setup.orm.execute(sql`SELECT id FROM parted`),
        ];
        const [ordinary, partitioned] = await Promise.all(
          (first === 'plain' ? reads : reads.toReversed()).map((read) => read()),
        );
        return $.h('p', null, JSON.stringify([ordinary?.rows.length, partitioned?.rows.length]));
      });

      await expect(render()).rejects.toThrow(REFUSED);
    },
  );

  it('is refused where the statement that asked the catalog failed beside it, not served what a write through the table changes', async () => {
    const setup = await openedWith({ parted, partedEu, partedUs, plain }, PARTITIONED);
    let renders = 0;
    const { engine, render } = await engineOf(setup, async (_props, $) => {
      renders += 1;
      // The first render's other statement reads a table that does not exist: its plan, which
      // carries the catalog, fails, and the statement of the partitioned table is planned beside it.
      const table = renders === 1 ? 'missing' : 'plain';
      const other = ranOrFailed(setup.orm.execute(sql.raw(`SELECT id FROM ${table}`)));
      const [, partitioned] = await Promise.all([
        other,
        setup.orm.execute(sql`SELECT id FROM parted`),
      ]);
      return $.h('p', null, String(partitioned.rows.length));
    });

    await expect(render()).rejects.toBeInstanceOf(Error);
    await expect(render()).rejects.toThrow(REFUSED);

    await setup.orm.insert(parted).values({ id: 'b', region: 'eu' });
    await engine.poke();

    await expect(render()).rejects.toThrow(REFUSED);
  });

  it('is refused where a join reads one, whatever else it reads', async () => {
    const setup = await openedWith({ parted, plain }, PARTITIONED);
    const { render } = await engineOf(
      setup,
      reading(setup, sql`SELECT plain.id FROM plain JOIN parted ON parted.id = plain.id`),
    );

    await expect(render()).rejects.toThrow(REFUSED);
  });
});

describe(
  'what a partitioned table beside it leaves as it was',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it('renders again what read an ordinary table its log says changed, beside a partitioned one', async () => {
      const setup = await openedWith({ parted, plain }, PARTITIONED);
      const evaluate = reading(setup, sql`SELECT id FROM plain ORDER BY id`);
      const { engine, render } = await engineOf(setup, evaluate);

      await expect(render()).resolves.toBe('["p"]');

      await setup.orm.insert(plain).values({ id: 'q' });
      await engine.poke();

      await expect(render()).resolves.toBe('["p","q"]');
      expect(evaluate).toHaveBeenCalledTimes(2);
    });

    it('logs a write through a declared partitioned table that no render reads', async () => {
      const setup = await openedWith({ parted }, PARTITIONED);
      const store = setup.follow.store(setup.pg);
      const { head } = await store.changes(0, 10);

      await setup.orm.insert(parted).values({ id: 'b', region: 'us' });
      const read = await store.changes(head, 10);

      expect(read.head).toBeGreaterThan(head);
    });
  },
);

/** The followed tables of the rows below: a partitioned table and an ordinary one. */
const followed: Followed = {
  byRelation: new Map([
    ['public.parted', 'parted'],
    ['public.plain', 'plain'],
  ]),
  keysByTable: new Map([
    ['parted', [{ column: 'id', field: 'k_id', kind: 'text' }]],
    ['plain', [{ column: 'id', field: 'k_id', kind: 'text' }]],
  ]),
  namespace: 'reactive_state',
  relations: [
    { name: 'parted', schema: 'public' },
    { name: 'plain', schema: 'public' },
  ],
  schema: { generation: 0 },
  schemaTable: 'reactive_state_schema_sql',
};

/** A table as the catalog says it, with no column. */
function catalogTable(name: string, kind: string, partition: boolean) {
  return { columns: [], hidden: false, kind, name, partition, schema: 'public' };
}

const TABLES = [
  catalogTable('parted', 'p', false),
  catalogTable('parted_eu', 'r', true),
  catalogTable('plain', 'r', false),
];

describe('which tables the catalog says are partitioned', () => {
  it.each<readonly [string, Record<string, unknown>]>([
    ['a catalog that follows conditions', { operators: false, utf8: true, version: 180_000 }],
    ['a PostgreSQL before 17', { operators: false, version: 160_004 }],
    ['an application `=` of a type a key may be', { operators: true, version: 180_000 }],
  ])('names the table, a partition of it, and no ordinary table: %s', (_name, facts) => {
    const { partitioned } = catalogOf([{ ...facts, tables: TABLES }], followed);

    expect(partitioned).toStrictEqual(new Set(['public.parted', 'public.parted_eu']));
  });

  it('names none where no table is partitioned, and where there is no catalog', () => {
    const ordinary = [catalogTable('parted', 'r', false), catalogTable('plain', 'r', false)];

    expect(
      catalogOf([{ operators: false, tables: ordinary, version: 180_000 }], followed).partitioned,
    ).toStrictEqual(new Set());
    expect(NO_CONDITIONS.partitioned).toBeUndefined();
  });
});
