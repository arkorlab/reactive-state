import { describe, expect, it } from 'vitest';

import { type Condition, conditionsOf } from '../src/sql/quals.ts';

/**
 * Which scan a condition is of. `sql-quals.test.ts` joins what `conditionsOf` answers for two
 * scans before it compares, so a condition handed to the wrong scan — or to both — passes there
 * wherever the other scan has none; these rows ask each scan alone. They pass as the module is
 * (a pin): a module that handed `projects.title` to the scan of `tasks` passes the other suite
 * and fails here.
 */

function equal(column: string, ...parameters: readonly number[]): Condition {
  return {
    bare: false,
    cast: false,
    column,
    operands: parameters.map((parameter) => ({ parameter })),
  };
}

const byColumn = (one: Condition, other: Condition): number =>
  one.column.localeCompare(other.column);

describe('which scan a condition is of', () => {
  it.each<readonly [string, string, string, readonly Condition[]]>([
    [
      'one column equal to a parameter',
      'tasks',
      '(tasks.project_id = $1)',
      [equal('project_id', 1)],
    ],
    [
      'the terms of an AND',
      'tasks',
      '((tasks.project_id = $1) AND (tasks.done = $2))',
      [equal('done', 2), equal('project_id', 1)],
    ],
    [
      'a varchar column cast to text',
      'projects',
      '((projects.title)::text = $1)',
      [{ ...equal('title', 1), cast: true }],
    ],
    ['the parameter first', 'tasks', '($1 = tasks.project_id)', [equal('project_id', 1)]],
    [
      'a constant of a type',
      'tasks',
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
      'tasks',
      '(tasks.id = 5)',
      [{ bare: false, cast: false, column: 'id', operands: [{ constant: '5' }] }],
    ],
    [
      'a boolean column alone',
      'tasks',
      'tasks.done',
      [{ bare: true, cast: false, column: 'done', operands: [{ constant: 'true' }] }],
    ],
    [
      'a boolean column negated',
      'tasks',
      '(NOT tasks.done)',
      [{ bare: true, cast: false, column: 'done', operands: [{ constant: 'false' }] }],
    ],
    [
      'a list of parameters',
      'tasks',
      '(tasks.project_id = ANY (ARRAY[$1, $2]))',
      [equal('project_id', 1, 2)],
    ],
    ['a quoted column', 'tasks', '(tasks."projectId" = $1)', [equal('projectId', 1)]],
  ])('gives %s to the scan it names alone', (_what, owner, expression, expected) => {
    const other = owner === 'tasks' ? 'projects' : 'tasks';

    expect(conditionsOf(expression, owner).toSorted(byColumn)).toStrictEqual(expected);
    expect(conditionsOf(expression, other)).toStrictEqual([]);
  });

  it('gives each scan its own terms of a condition that names both', () => {
    const expression = '((tasks.project_id = $1) AND ((projects.title)::text = $2))';

    expect(conditionsOf(expression, 'tasks')).toStrictEqual([equal('project_id', 1)]);
    expect(conditionsOf(expression, 'projects')).toStrictEqual([
      { ...equal('title', 2), cast: true },
    ]);
  });
});
