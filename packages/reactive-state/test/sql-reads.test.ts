import { describe, expect, it, vi } from 'vitest';

import type { Catalog } from '../src/sql/catalog.ts';
import type { Followed } from '../src/sql/keys.ts';
import type { Condition } from '../src/sql/quals.ts';
import { keyDigest, readsOf, type TableScan } from '../src/sql/reads.ts';

/**
 * What a statement's scans read, bound to the values it ran with: the records their conditions
 * name, by the keys the catalog follows — or the table whole, where what a condition names is not
 * known as PostgreSQL compares it.
 */

const followed: Followed = {
  byRelation: new Map([
    ['public.labels', 'labels'],
    ['public.tasks', 'tasks'],
  ]),
  keysByTable: new Map([
    ['labels', [{ column: 'id', field: 'k_id', kind: 'text' }]],
    [
      'tasks',
      [
        { column: 'project_id', field: 'k_project_id', kind: 'text' },
        { column: 'status', field: 'k_status', kind: 'text' },
        { column: 'id', field: 'k_id', kind: 'integer' },
      ],
    ],
  ]),
  namespace: 'reactive_state',
  relations: [
    { name: 'labels', schema: 'public' },
    { name: 'tasks', schema: 'public' },
  ],
  schema: { generation: 0 },
  schemaTable: 'reactive_state_schema_sql',
};

/** The catalog of `tasks`, whose `status` is an enum, and of `labels`, whose rows a policy hides. */
const catalog: Catalog = {
  hidden: new Set(['labels']),
  keys: new Map([
    ['labels', new Set()],
    ['tasks', new Set(['id', 'project_id', 'status'])],
  ]),
  types: new Map([
    ['labels', new Map()],
    [
      'tasks',
      new Map([
        ['id', 'int4'],
        ['project_id', 'text'],
        ['status', 'status'],
      ]),
    ],
  ]),
};

function constant(column: string, text: string, type?: string): Condition {
  return {
    bare: false,
    cast: false,
    column,
    operands: [type === undefined ? { constant: text } : { constant: text, type }],
  };
}

function scanOf(table: string, ...conditions: readonly Condition[]): TableScan {
  return { conditions, table };
}

describe("a statement's reads", () => {
  it.each<readonly [string, Condition, Readonly<Record<string, string>>]>([
    [
      'a constant of the key own enum',
      constant('status', 'open', 'status'),
      { k_status: keyDigest('open') },
    ],
    ['a constant of text', constant('project_id', 'p1', 'text'), { k_project_id: keyDigest('p1') }],
    ['a whole number of no type', constant('id', '5'), { k_id: keyDigest('5') }],
    ['a constant of a domain', constant('project_id', 'p1', 'ci_text'), {}],
    ['a constant of another enum', constant('status', 'open', 'other_status'), {}],
  ])('names the records of %s', (_what, condition, where) => {
    expect(readsOf([scanOf('tasks', condition)], { values: [] }, followed, catalog)).toStrictEqual([
      { table: 'tasks', where },
    ]);
  });

  it('names no records of a text parameter longer than a name keeps', () => {
    const parameter: Condition = {
      bare: false,
      cast: false,
      column: 'project_id',
      operands: [{ parameter: 1 }],
    };

    expect(
      readsOf([scanOf('tasks', parameter)], { values: ['p'.repeat(63)] }, followed, catalog),
    ).toStrictEqual([{ table: 'tasks', where: { k_project_id: keyDigest('p'.repeat(63)) } }]);
    expect(
      readsOf([scanOf('tasks', parameter)], { values: ['p'.repeat(64)] }, followed, catalog),
    ).toStrictEqual([{ table: 'tasks', where: {} }]);
  });

  it('reads no value of a list past the queries a read is noted as', () => {
    const list: Condition = {
      bare: false,
      cast: false,
      column: 'project_id',
      operands: Array.from({ length: 40 }, (_each, at) => ({ parameter: at + 1 })),
    };
    const bound = vi.fn(() => true);
    const values = Array.from({ length: 40 }, (_each, at) => `p${String(at)}`);

    expect(readsOf([scanOf('tasks', list)], { bound, values }, followed, catalog)).toStrictEqual([
      { table: 'tasks', where: {} },
    ]);
    expect(bound).not.toHaveBeenCalled();
  });

  it('reads every table of a statement whole that reads a table whose rows a policy hides', () => {
    const scans = [scanOf('labels'), scanOf('tasks', constant('project_id', 'p1', 'text'))];

    expect(readsOf(scans, { values: [] }, followed, catalog)).toStrictEqual([
      { table: 'labels', where: {} },
      { table: 'tasks', where: {} },
    ]);
  });
});
