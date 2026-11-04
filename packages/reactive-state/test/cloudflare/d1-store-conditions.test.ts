import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { d1Executor, d1Store } from '../../src/cloudflare/d1-store.ts';
import { table, text } from '../../src/server/schema.ts';

/** D1 allows one hundred columns and one hundred bindings, including the record's id. */
const COLUMNS = 100;
const names = Array.from({ length: COLUMNS - 1 }, (_, at) => `field_${String(at)}`);
const declared = table(Object.fromEntries(names.map((name) => [name, text({ default: 'same' })])), {
  external: 'main',
});
const records = { name: 'condition_records', table: declared };
const executor = d1Executor(env.REACTIVE_D1);

describe('a D1 query at the supported condition boundary', () => {
  beforeEach(async () => {
    await executor.all('DROP TABLE IF EXISTS condition_records', []);
    const columns = names.map((name) => `${name} TEXT`).join(', ');
    await executor.all(`CREATE TABLE condition_records (id INTEGER PRIMARY KEY, ${columns})`, []);
  });

  it.each([
    { what: 'scalar equality', held: 'other', asked: 'other' },
    { what: 'NULL default branches', held: null, asked: 'same' },
  ])('executes count and find with one hundred $what conditions', async ({ held, asked }) => {
    const values = [2, ...names.map(() => held)];
    await executor.all(
      `INSERT INTO condition_records VALUES (${values.map(() => '?').join(', ')})`,
      values,
    );
    const executed: { readonly sql: string; readonly params: readonly unknown[] }[] = [];
    const store = d1Store({
      all: async (sql, params) => {
        executed.push({ sql, params });
        return executor.all(sql, params);
      },
    });
    const where = { id: '2', ...Object.fromEntries(names.map((name) => [name, asked])) };

    await expect(store.count(records, where)).resolves.toBe(1);
    await expect(store.find(records, { where, orderBy: [], limit: 1 })).resolves.toMatchObject([
      { id: '2' },
    ]);
    expect(executed).toHaveLength(2);

    for (const { sql, params } of executed) {
      const plan = await executor.all(`EXPLAIN QUERY PLAN ${sql}`, params);
      const detail = plan.map((row) => row['detail']).join(' ');

      expect(params).toHaveLength(COLUMNS);
      expect(detail).toContain('SEARCH condition_records USING');
      expect(detail).not.toContain('SCAN condition_records');
    }
  });
});
