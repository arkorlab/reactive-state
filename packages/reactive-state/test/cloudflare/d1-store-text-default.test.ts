import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { externalFind, externalGet } from '../../src/authority/external.ts';
import { d1Executor, d1Store } from '../../src/cloudflare/d1-store.ts';
import { table, text } from '../../src/server/schema.ts';

const DEFAULT = "a\0'界😀z";
const declared = table({ label: text({ default: DEFAULT }) }, { external: 'main' });
const records = { name: 'text_default_records', table: declared };
const executor = d1Executor(env.REACTIVE_D1);
const store = d1Store(executor);
const COLUMNS = 100;

describe('text defaults containing NUL in D1', () => {
  beforeEach(async () => {
    await executor.all('DROP TABLE IF EXISTS text_default_records', []);
    await executor.all('DROP TABLE IF EXISTS wide_default_records', []);
    await executor.all('CREATE TABLE text_default_records (id TEXT PRIMARY KEY, label TEXT)', []);
    await executor.all(
      'INSERT INTO text_default_records VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)',
      ['null', null, 'same', DEFAULT, 'before', 'a', 'after', 'b', 'empty', ''],
    );
  });

  it('orders NULL as the complete declared default before applying a limit', async () => {
    const query = { where: {}, orderBy: [{ field: 'label', descending: false }], limit: undefined };

    await expect(externalFind(store, records, query, undefined)).resolves.toMatchObject([
      { id: 'empty', label: '' },
      { id: 'before', label: 'a' },
      { id: 'null', label: DEFAULT },
      { id: 'same', label: DEFAULT },
      { id: 'after', label: 'b' },
    ]);
    await expect(
      externalFind(store, records, { ...query, limit: 3 }, undefined),
    ).resolves.toMatchObject([{ id: 'empty' }, { id: 'before' }, { id: 'null' }]);
    await expect(
      externalFind(
        store,
        records,
        { ...query, orderBy: [{ field: 'label', descending: true }], limit: 2 },
        undefined,
      ),
    ).resolves.toMatchObject([{ id: 'after' }, { id: 'null' }]);
  });

  it('keeps point reads and predicates consistent with the same NULL default', async () => {
    await expect(externalGet(store, records, 'null')).resolves.toMatchObject({ label: DEFAULT });
    await expect(store.count(records, { label: DEFAULT })).resolves.toBe(2);
    await expect(
      externalFind(
        store,
        records,
        { where: { label: DEFAULT }, orderBy: [], limit: undefined },
        undefined,
      ),
    ).resolves.toMatchObject([
      { id: 'null', label: DEFAULT },
      { id: 'same', label: DEFAULT },
    ]);
  });

  it('uses no extra binding to order a query with one hundred conditions', async () => {
    const names = Array.from({ length: COLUMNS - 1 }, (_, at) => `field_${String(at)}`);
    const wide = {
      name: 'wide_default_records',
      table: table(Object.fromEntries(names.map((name) => [name, text({ default: DEFAULT })])), {
        external: 'main',
      }),
    };
    const columns = names.map((name) => `${name} TEXT`).join(', ');
    await executor.all(
      `CREATE TABLE wide_default_records (id INTEGER PRIMARY KEY, ${columns})`,
      [],
    );
    await executor.all('INSERT INTO wide_default_records (id) VALUES (2)', []);
    const bound: (readonly unknown[])[] = [];
    const observed = d1Store({
      all: (statement, params) => {
        bound.push(params);
        return executor.all(statement, params);
      },
    });
    const where = { id: '2', ...Object.fromEntries(names.map((name) => [name, DEFAULT])) };

    await expect(observed.count(wide, where)).resolves.toBe(1);
    await expect(
      observed.find(wide, {
        where,
        orderBy: [{ field: 'field_0', descending: false }],
        limit: 1,
      }),
    ).resolves.toMatchObject([{ id: '2' }]);
    expect(bound.map((params) => params.length)).toStrictEqual([COLUMNS, COLUMNS]);
  });
});
