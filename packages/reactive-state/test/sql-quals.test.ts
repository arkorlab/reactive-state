import { describe, expect, it } from 'vitest';

import { catalogOf } from '../src/sql/catalog.ts';
import type { Followed } from '../src/sql/keys.ts';
import { type Condition, conditionsOf } from '../src/sql/quals.ts';

/**
 * The conditions of a scan the authority follows a read by, as PostgreSQL 18 writes them in a
 * generic plan's `Filter`, `Index Cond` and `Recheck Cond`; and what the catalog says they may be
 * followed by. What is left out widens the read: it is never followed by fewer changes.
 */

function equal(column: string, ...parameters: readonly number[]): Condition {
  return {
    bare: false,
    cast: false,
    column,
    operands: parameters.map((parameter) => ({ parameter })),
  };
}

describe("a scan's conditions", () => {
  it.each<readonly [string, string, readonly Condition[]]>([
    ['one column equal to a parameter', '(tasks.project_id = $1)', [equal('project_id', 1)]],
    [
      'the terms of an AND',
      '((tasks.project_id = $1) AND (tasks.done = $2))',
      [equal('done', 2), equal('project_id', 1)],
    ],
    [
      'a varchar column cast to text',
      '((projects.title)::text = $1)',
      [{ ...equal('title', 1), cast: true }],
    ],
    ['the parameter first', '($1 = tasks.project_id)', [equal('project_id', 1)]],
    [
      'a constant of a type',
      "(tasks.status = 'open'::status)",
      [
        {
          bare: false,
          cast: false,
          column: 'status',
          operands: [{ constant: 'open', type: 'status' }],
        },
      ],
    ],
    [
      'a whole number',
      '(tasks.id = 5)',
      [{ bare: false, cast: false, column: 'id', operands: [{ constant: '5' }] }],
    ],
    [
      'a constant of a qualified type',
      "(tasks.status = 'open'::app.status)",
      [
        {
          bare: false,
          cast: false,
          column: 'status',
          operands: [{ constant: 'open', schema: 'app', type: 'status' }],
        },
      ],
    ],
    [
      'a constant of a quoted qualified type',
      `(tasks.status = 'open'::"odd.schema"."Status""Name")`,
      [
        {
          bare: false,
          cast: false,
          column: 'status',
          operands: [{ constant: 'open', schema: 'odd.schema', type: 'Status"Name' }],
        },
      ],
    ],
    [
      'a boolean column alone',
      'tasks.done',
      [{ bare: true, cast: false, column: 'done', operands: [{ constant: 'true' }] }],
    ],
    [
      'a boolean column negated',
      '(NOT tasks.done)',
      [{ bare: true, cast: false, column: 'done', operands: [{ constant: 'false' }] }],
    ],
    [
      'a list of parameters',
      '(tasks.project_id = ANY (ARRAY[$1, $2]))',
      [equal('project_id', 1, 2)],
    ],
    [
      'a list of qualified enum constants',
      "(tasks.status = ANY (ARRAY['open'::app.status, 'closed'::app.status]))",
      [
        {
          bare: false,
          cast: false,
          column: 'status',
          operands: [
            { constant: 'open', schema: 'app', type: 'status' },
            { constant: 'closed', schema: 'app', type: 'status' },
          ],
        },
      ],
    ],
    ['a quoted column', '(tasks."projectId" = $1)', [equal('projectId', 1)]],
  ])('takes %s', (_what, expression, expected) => {
    expect(
      [...conditionsOf(expression, 'tasks'), ...conditionsOf(expression, 'projects')].toSorted(
        (one, other) => one.column.localeCompare(other.column),
      ),
    ).toStrictEqual(expected);
  });

  it.each([
    ['an OR', '((tasks.project_id = $1) OR (tasks.assignee_id = $2))'],
    ['NOT of an AND', '(NOT ((tasks.project_id = $1) AND (tasks.done = $2)))'],
    ['a range', '(tasks.id > $1)'],
    ['IS NULL', '(tasks.assignee_id IS NULL)'],
    ['a column of another relation', '(tasks.project_id = projects.id)'],
    ["a subquery's value", '(tasks.project_id = (InitPlan 1).col1)'],
    ['a collation', '(tasks.project_id = $1 COLLATE "C")'],
    ['a constant of a collation', `(tasks.project_id = 'p1'::text COLLATE "und-x-icu")`],
    ['a qualified constant of a collation', `(tasks.project_id = 'p1'::app.status COLLATE "C")`],
    // As PostgreSQL writes `a\b` with `standard_conforming_strings` off.
    ['a constant of a backslash', String.raw`(tasks.title = 'a\\b'::text)`],
    ['a function', '(lower(tasks.title) = $1)'],
    ['a cast other than to text', '((tasks.id)::bigint = $1)'],
    ['a list of an array parameter', '(tasks.project_id = ANY ($1))'],
    ['a constant array', "(tasks.project_id = ANY ('{p1,p2}'::text[]))"],
    ['an operand computed', '(tasks.id = ($1 + 1))'],
    ['a not-equal', '(tasks.id <> $1)'],
    ['a fraction', '(tasks.id = 5.0)'],
    ['an escaped string', String.raw`(tasks.title = E'a\\b'::text)`],
  ])('leaves out %s', (_what, expression) => {
    expect(conditionsOf(expression, 'tasks')).toStrictEqual([]);
  });

  it('keeps the terms it takes of an AND whose other terms it leaves out', () => {
    expect(
      conditionsOf(
        '((tasks.assignee_id IS NULL) AND (tasks.project_id = ANY (ARRAY[$1, $2])) AND (tasks.id > $3))',
        'tasks',
      ),
    ).toStrictEqual([equal('project_id', 1, 2)]);
  });

  it('names columns of the scan its alias names alone', () => {
    expect(conditionsOf('(projects_tasks.done = $1)', 'tasks')).toStrictEqual([]);
    expect(conditionsOf('(projects_tasks.done = $1)', 'projects_tasks')).toStrictEqual([
      equal('done', 1),
    ]);
  });
});

/** A column as the catalog says it: its name, type, kind of type and collation. */
function catalogColumn(name: string, type: string, category: string, deterministic: boolean) {
  return { builtin: category === 'b', category, deterministic, name, type };
}

describe('what the catalog says conditions are followed by', () => {
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
          { column: 'id', field: 'k_id', kind: 'integer' },
          { column: 'name', field: 'k_name', kind: 'text' },
          { column: 'kind', field: 'k_kind', kind: 'text' },
          { column: 'owner', field: 'k_owner', kind: 'uuid' },
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
  const tables = [
    {
      columns: [
        catalogColumn('id', 'int4', 'b', true),
        // A collation that finds two texts equal, and a type the schema did not say.
        catalogColumn('name', 'text', 'b', false),
        catalogColumn('kind', 'kinds', 'e', true),
        catalogColumn('owner', 'text', 'b', true),
      ],
      hidden: false,
      kind: 'r',
      name: 'tasks',
      partition: false,
      schema: 'public',
    },
    {
      columns: [catalogColumn('id', 'text', 'b', true)],
      hidden: true,
      kind: 'r',
      name: 'labels',
      partition: false,
      schema: 'public',
    },
  ];

  it('follows key columns of their types and deterministic collations, of tables no policy hides', () => {
    const catalog = catalogOf(
      [{ operators: false, tables, utf8: true, version: 180_000 }],
      followed,
    );

    expect(catalog.keys.get('tasks')).toStrictEqual(new Set(['id', 'kind']));
    expect(catalog.keys.get('labels')).toStrictEqual(new Set());
  });

  it('follows no condition before PostgreSQL 17', () => {
    expect(catalogOf([{ operators: false, tables, version: 160_004 }], followed).keys.size).toBe(0);
  });

  it('follows no condition where the application has an `=` of a type a key may be', () => {
    expect(catalogOf([{ operators: true, tables, version: 180_000 }], followed).keys.size).toBe(0);
  });

  it('follows no text key of a database of another encoding than UTF-8', () => {
    const catalog = catalogOf(
      [{ operators: false, tables, utf8: false, version: 180_000 }],
      followed,
    );

    expect(catalog.keys.get('tasks')).toStrictEqual(new Set(['id']));
  });

  it("follows no key of the application's type of a name of PostgreSQL's", () => {
    const named = [
      {
        ...tables[0],
        columns: [
          // An enum, and a type of no schema of PostgreSQL's, each named as PostgreSQL's `text` is.
          catalogColumn('name', 'text', 'e', true),
          { ...catalogColumn('kind', 'text', 'b', true), builtin: false },
        ],
      },
    ];
    const catalog = catalogOf(
      [{ operators: false, tables: named, utf8: true, version: 180_000 }],
      followed,
    );

    expect(catalog.keys.get('tasks')).toStrictEqual(new Set());
  });

  it("follows no condition where a view or a SQL function names a table's columns otherwise", () => {
    const bodies = [' SELECT p.code, p.id AS org FROM projects p(code, id);'];
    const trees = [
      '({QUERY :rtable ({RANGETBLENTRY :alias {ALIAS :aliasname p :colnames ("code" "id")} :eref {ALIAS :aliasname p :colnames ("code" "id" "title")} :rtekind 0 :relid 16384})})',
    ];
    const spaced = [
      String.raw`({QUERY :rtable ({RANGETBLENTRY :alias {ALIAS :aliasname a\ p :colnames ("code" "id")} :eref {ALIAS :aliasname a\ p :colnames ("code" "id" "title")} :rtekind 0 :relid 16384 :relkind r})})`,
    ];
    const ofView = [
      '({QUERY :rtable ({RANGETBLENTRY :alias {ALIAS :aliasname w :colnames ("a")} :eref {ALIAS :aliasname w :colnames ("a" "b")} :rtekind 0 :relid 16390 :relkind v})})',
    ];
    const called = [
      '({QUERY :rtable ({RANGETBLENTRY :alias {ALIAS :aliasname g :colnames ("i")} :eref {ALIAS :aliasname g :colnames ("i")} :rtekind 3 :functions <>})})',
    ];
    const base = { operators: false, tables, utf8: true, version: 180_000 };

    expect(catalogOf([{ ...base, bodies }], followed).keys.size).toBe(0);
    expect(catalogOf([{ ...base, trees }], followed).keys.size).toBe(0);
    expect(catalogOf([{ ...base, trees: spaced }], followed).keys.size).toBe(0);
    expect(catalogOf([{ ...base, trees: called }], followed).keys.size).toBeGreaterThan(0);
    expect(catalogOf([{ ...base, trees: ofView }], followed).keys.size).toBeGreaterThan(0);
  });
});
