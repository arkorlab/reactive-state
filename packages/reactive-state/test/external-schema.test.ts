import { describe, expect, it } from 'vitest';

import { entryOf, queryOf } from '../src/authority/query.ts';
import { boolean, database, integer, json, table, text } from '../src/server/index.ts';
import { checkValue, definitionOf } from '../src/server/schema.ts';

/** The declaration and query contracts of tables whose records the host's store owns. */
describe('external table declarations', () => {
  it('keeps the store name and document fields in the declaration', () => {
    const records = table({ payload: json(), enabled: boolean() }, { external: 'control' });
    const declaration = definitionOf(database({ records }));

    expect(declaration.tables.get('records')).toMatchObject({
      external: 'control',
      fields: { payload: { default: null, type: 'json' } },
    });
  });

  it.each([
    ['a document in a table the authority writes', () => table({ payload: json() })],
    ['an invalid store name', () => table({ title: text() }, { external: 'not-a-name' })],
    ['public fields', () => table({ title: text() }, { external: 'store', public: ['title'] })],
    ['unique groups', () => table({ title: text() }, { external: 'store', unique: [['title']] })],
    [
      'seed records',
      () => {
        return database(
          { records: table({ title: text() }, { external: 'store' }) },
          {
            seed: { records: { first: { title: 'first' } } },
          },
        );
      },
    ],
  ])('refuses %s', (_, declare) => {
    expect(declare).toThrow(TypeError);
  });

  it('refuses a field reference to an external record before any evaluation', () => {
    const db = database({ records: table({ title: text() }, { external: 'store' }) });

    expect(() => db.records.ref('first')).toThrow('whose records no state is bound to');
  });

  it('keeps a selected null document as null', () => {
    const record = entryOf({ id: 'first', values: { payload: null, enabled: false } }, ['payload']);

    expect(record).toStrictEqual({ payload: null });
  });

  it('permits a limit and selecting documents, but never predicates or ordering on them', () => {
    const records = table({ payload: json(), rank: integer() }, { external: 'store' });
    const query = queryOf(
      'find',
      records,
      {
        limit: 2,
        orderBy: [{ rank: 'desc' }],
        select: { payload: true },
        where: {},
      },
      'findMany',
    );

    expect(query.limit).toBe(2);
    expect(query.select).toStrictEqual(['payload']);
    expect(() => queryOf('find', records, { where: { payload: null } }, 'findMany')).toThrow(
      'a document',
    );
    expect(() =>
      queryOf('find', records, { where: {}, orderBy: [{ payload: 'asc' }] }, 'findMany'),
    ).toThrow('a document');
  });
});

describe('external documents', () => {
  it.each([null, true, 'text', 2, { nested: ['text', null, { enabled: true }] }])(
    'accepts JSON: %j',
    (value) => {
      expect(checkValue(json(), value)).toBeUndefined();
    },
  );

  it.each([undefined, NaN, Infinity, new Date(), new Map(), () => 1])(
    'refuses a value JSON would carry otherwise: %s',
    (value) => {
      expect(checkValue(json(), value)).toBe('The value is not JSON.');
    },
  );

  it('refuses a cycle and an accessor without reading it', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    let reads = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        reads += 1;
        return 'secret';
      },
    });

    expect(checkValue(json(), cyclic)).toBe('The value is not JSON.');
    expect(checkValue(json(), accessor)).toBe('The value is not JSON.');
    expect(reads).toBe(0);
  });
});
