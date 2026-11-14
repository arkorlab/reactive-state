import { isForOfStatement, type Expression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { iteratedFrameSources } from '../src/compiler/framed-assignment-patterns.ts';

/**
 * A type parameter no actual argument fills is to the reader what its written constraint says, so
 * that iterating a value of `T extends [string, Error]` produces the member of each place the
 * constraint has, as iterating a value of that tuple does. The constraint is read through another
 * parameter's and an alias's; a constraint that is no tuple, and a parameter with none, keep the one
 * place that stands for the elements. Each row is the sources `iteratedFrameSources` gives the
 * iterated parameter `values`, as written.
 */
const CASES = [
  {
    declarations: '',
    parameters: '<T extends [string, Error]>',
    sources: ['values.0', 'values.1'],
    what: 'a tuple constraint',
  },
  {
    declarations: '',
    parameters: '<T extends [string, Error?]>',
    sources: ['values.0', 'values.1'],
    what: 'a tuple constraint with an optional member',
  },
  {
    declarations: '',
    parameters: '<T extends [string, ...Error[]]>',
    sources: ['values.0', 'values.1'],
    what: 'a tuple constraint with a rest',
  },
  {
    declarations: '',
    parameters: '<T extends readonly [string, Error]>',
    sources: ['values.0', 'values.1'],
    what: 'a readonly tuple constraint',
  },
  {
    declarations: '',
    parameters: '<T extends [string] | [string, Error]>',
    sources: ['values.0', 'values.1'],
    what: 'a union of tuple constraints',
  },
  {
    declarations: 'type Pair = [string, Error];',
    parameters: '<T extends Pair>',
    sources: ['values.0', 'values.1'],
    what: 'an alias constraint',
  },
  {
    declarations: '',
    parameters: '<U extends [string, Error], T extends U>',
    sources: ['values.0', 'values.1'],
    what: 'a constraint through another parameter',
  },
  {
    declarations: '',
    parameters: '<T extends []>',
    sources: [],
    what: 'an empty tuple constraint',
  },
  { declarations: '', parameters: '<T extends Error[]>', sources: ['values.0'], what: 'an array' },
  { declarations: '', parameters: '<T>', sources: ['values.0'], what: 'a parameter without one' },
  {
    declarations: '',
    parameters: '<T extends Iterable<Error>>',
    sources: ['values.0'],
    what: 'an iterable constraint',
  },
] as const;

const FILLED = [
  {
    declarations: 'type Same<T extends unknown[]> = T;',
    type: 'Same<[string, Error, number]>',
    sources: ['values.0', 'values.1', 'values.2'],
    what: 'an actual argument, not its constraint',
  },
  {
    declarations: 'type Same<T extends [string, Error]> = T;',
    type: 'Same<[string, Error]>',
    sources: ['values.0', 'values.1'],
    what: 'an actual argument beside a constraint',
  },
] as const;

describe('the places an iterated type parameter is read at', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The sources `iteratedFrameSources` gives the iterated `values` of a program, as written. */
  function iterated(declarations: string, parameters: string, type: string): readonly string[] {
    using parsed = api.createSourceFile(
      'iteration-constraints.ts',
      `${declarations}\nfunction frames${parameters}(values: ${type}) { let e: unknown = 0; for (e of values) {} return e; }\n`,
    );
    let iterable: Expression | undefined;
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (isForOfStatement(at)) iterable = at.expression;
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    if (iterable === undefined) throw new Error(`No iteration is written for ${type}.`);
    return iteratedFrameSources(iterable).map((source) =>
      [source.value.getText(), ...source.keys].join('.'),
    );
  }

  it.each(CASES)('reads $what', ({ declarations, parameters, sources }) => {
    expect(iterated(declarations, parameters, 'T')).toStrictEqual(sources);
  });

  it.each(FILLED)('reads $what', ({ declarations, type, sources }) => {
    expect(iterated(declarations, '', type)).toStrictEqual(sources);
  });
});
