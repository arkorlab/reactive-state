import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ExternalQuery } from '../../src/authority/external.ts';
import type { Where } from '../../src/authority/query.ts';
import { changeCaptureSql, d1Executor, d1Store } from '../../src/cloudflare/d1-store.ts';
import { database, table, text } from '../../src/server/schema.ts';

const declared = table({ group: text() }, { external: 'main' });
const records = { name: 'records', table: declared };
const mapping = { records: { id: 'key', name: 'id_records' } };
const executor = d1Executor(env.REACTIVE_D1);
const store = d1Store(executor, mapping);
const MAX_INTEGER_ID = '9223372036854775807';
const QUERY_CONDITIONS = 100;

async function sql(statement: string, params: readonly unknown[] = []) {
  return executor.all(statement, params);
}

function query(where: Where = {}, limit?: number): ExternalQuery {
  return { limit, orderBy: [], where };
}

describe('a D1 store exposing record IDs as strings', () => {
  beforeEach(async () => {
    await sql('DROP TABLE IF EXISTS id_records');
    await sql('DROP TABLE IF EXISTS _rs_changes');
    await sql('DROP TABLE IF EXISTS _rs_meta');
    await sql('CREATE TABLE id_records (key INTEGER PRIMARY KEY, "group" TEXT)');
    await sql('INSERT INTO id_records VALUES (2, ?), (10, ?)', ['same', 'same']);
  });

  it('orders integer IDs as strings before limiting and as a field-order tie', async () => {
    await expect(store.find(records, query())).resolves.toMatchObject([{ id: '10' }, { id: '2' }]);
    await expect(store.find(records, query({}, 1))).resolves.toMatchObject([{ id: '10' }]);

    for (const field of ['id', 'group']) {
      const ordered = { ...query({}, 1), orderBy: [{ descending: false, field }] };

      await expect(store.find(records, ordered)).resolves.toMatchObject([{ id: '10' }]);
    }

    await expect(
      store.find(records, { ...query({}, 1), orderBy: [{ descending: true, field: 'id' }] }),
    ).resolves.toMatchObject([{ id: '2' }]);
  });

  it.each(['02', '2.0', '2e0', '+2'])(
    'does not treat %s as the exposed ID 2 in get, find or count',
    async (id) => {
      await expect(store.get(records, '2')).resolves.toMatchObject({ id: '2' });
      await expect(store.find(records, query({ id: '2' }))).resolves.toMatchObject([{ id: '2' }]);
      await expect(store.count(records, { id: '2' })).resolves.toBe(1);

      await expect(store.get(records, id)).resolves.toBeNull();
      await expect(store.find(records, query({ id }))).resolves.toStrictEqual([]);
      await expect(store.count(records, { id })).resolves.toBe(0);
    },
  );

  it('preserves a signed 64-bit ID in records and delete changes', async () => {
    const statements = changeCaptureSql(database({ records: declared }), 'main', mapping);
    for (const statement of statements) {
      await sql(statement);
    }
    await sql(`INSERT INTO id_records VALUES (${MAX_INTEGER_ID}, 'large')`);

    await expect(store.get(records, MAX_INTEGER_ID)).resolves.toMatchObject({ id: MAX_INTEGER_ID });
    await expect(store.find(records, query({ id: MAX_INTEGER_ID }))).resolves.toMatchObject([
      { id: MAX_INTEGER_ID },
    ]);
    await expect(store.count(records, { id: MAX_INTEGER_ID })).resolves.toBe(1);

    await sql('DELETE FROM id_records WHERE key = ?', [MAX_INTEGER_ID]);

    const log = await store.changes(0, 10);

    expect(log.changes.at(-1)).toMatchObject({ after: null, id: MAX_INTEGER_ID });
  });

  it.each(['INTEGER', 'TEXT COLLATE NOCASE'])(
    'keeps %s primary-key lookups indexed while enforcing exact string identity',
    async (type) => {
      await sql('DROP TABLE id_records');
      await sql(`CREATE TABLE id_records (key ${type} PRIMARY KEY, "group" TEXT)`);
      const id = type === 'INTEGER' ? '2' : 'A';
      const other = type === 'INTEGER' ? '02' : 'a';
      await sql('INSERT INTO id_records VALUES (?, ?)', [id, 'same']);
      const executed: { readonly statement: string; readonly params: readonly unknown[] }[] = [];
      const observed = d1Store(
        {
          all: async (statement, params) => {
            executed.push({ params, statement });
            return executor.all(statement, params);
          },
        },
        mapping,
      );

      await expect(observed.get(records, id)).resolves.toMatchObject({ id });
      await expect(observed.find(records, query({ id }))).resolves.toMatchObject([{ id }]);
      await expect(observed.count(records, { id })).resolves.toBe(1);
      await expect(observed.get(records, other)).resolves.toBeNull();
      await expect(observed.find(records, query({ id: other }))).resolves.toStrictEqual([]);
      await expect(observed.count(records, { id: other })).resolves.toBe(0);

      for (const { params, statement } of executed) {
        const plan = await sql(`EXPLAIN QUERY PLAN ${statement}`, params);
        const detail = plan.map((row) => row['detail']).join(' ');

        expect(detail).toContain('SEARCH id_records USING');
        expect(detail).not.toContain('SCAN id_records');
      }
    },
  );

  it('reuses the ID binding when a query reaches D1’s 100-parameter limit', async () => {
    const fields = Object.fromEntries(
      Array.from({ length: QUERY_CONDITIONS - 1 }, (_, at) => [`field_${String(at)}`, text()]),
    );
    let bound: readonly unknown[] = [];
    const bounded = d1Store({
      all: (_statement, params) => {
        bound = params;
        return Promise.resolve([{ counted: 1 }]);
      },
    });
    const wide = { name: 'records', table: table(fields, { external: 'main' }) };
    const where = {
      id: '2',
      ...Object.fromEntries(Object.keys(fields).map((field) => [field, 'same'])),
    };

    await expect(bounded.count(wide, where)).resolves.toBe(1);
    expect(bound).toHaveLength(QUERY_CONDITIONS);
  });
});
