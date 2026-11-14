import { isForOfStatement, type Expression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { iteratedFrameSources } from '../src/compiler/framed-assignment-patterns.ts';

/**
 * Iterating a written tuple produces the member of every place it has, so that no one place stands
 * for the others: `for (e of values)` over `[string, Error?]` may assign `e` the `Error` of the
 * second place, and over `[string, ...Error[]]` one of the rest's. Each place of the tuple is a
 * source, the places of every alternative of a union, and the places a written tuple rest takes
 * after it; a native array or any other iterable keeps the one place that stands for its elements.
 * Each row is the sources `iteratedFrameSources` gives the iterated parameter `values`, as written.
 */
const CASES = [
  {
    type: '[string, Error?]',
    sources: ['values.0', 'values.1'],
    what: 'an optional member',
  },
  {
    type: '[string?, Error?]',
    sources: ['values.0', 'values.1'],
    what: 'optional members only',
  },
  {
    type: '[first: string, second?: Error]',
    sources: ['values.0', 'values.1'],
    what: 'a named optional member',
  },
  {
    type: '[string, ...Error[]]',
    sources: ['values.0', 'values.1'],
    what: 'a rest of errors',
  },
  {
    type: '[string, ...rest: Error[]]',
    sources: ['values.0', 'values.1'],
    what: 'a named rest',
  },
  {
    type: '[...Error[], string]',
    sources: ['values.0', 'values.1'],
    what: 'a leading rest',
  },
  {
    type: '[string, ...string[], Error]',
    sources: ['values.0', 'values.1', 'values.2'],
    what: 'a member after a rest',
  },
  {
    type: 'readonly [string, Error?]',
    sources: ['values.0', 'values.1'],
    what: 'a readonly tuple',
  },
  {
    type: '[string, Error?] | string[]',
    sources: ['values.0', 'values.1'],
    what: 'a tuple beside an array',
  },
  {
    type: '[string] | [string, Error?]',
    sources: ['values.0', 'values.1'],
    what: 'the places of both tuples',
  },
  {
    type: '[string, Error]',
    sources: ['values.0', 'values.1'],
    what: 'a required tuple',
  },
  { type: '[]', sources: [], what: 'an empty tuple' },
  { type: '[] | Error[]', sources: ['values.0'], what: 'an empty tuple beside an array' },
  { type: 'Error[]', sources: ['values.0'], what: 'an array' },
  { type: 'Iterable<Error>', sources: ['values.0'], what: 'another iterable' },
] as const;

const DECLARED = [
  {
    declarations: 'type Pair = [string, Error]; type Values = [...Pair, number];',
    sources: ['values.0', 'values.1', 'values.2'],
    what: 'a written tuple rest',
  },
  {
    declarations: 'type Values = [string, Error?];',
    sources: ['values.0', 'values.1'],
    what: 'an alias of a tuple',
  },
  {
    declarations: 'type Slots<T> = [string, T?]; type Values = Slots<Error>;',
    sources: ['values.0', 'values.1'],
    what: 'a generic tuple of an argument',
  },
  {
    declarations: 'type Pair = [string] | [string, Error]; type Values = [...Pair, number];',
    sources: ['values.0', 'values.1', 'values.2'],
    what: 'a written tuple rest of two lengths',
  },
  {
    declarations: 'type Values = [] | [string, ...Values];',
    sources: ['values.0', 'values.1'],
    what: 'a tuple that is its own rest',
  },
] as const;

describe('the places an iterated tuple is read at', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The sources `iteratedFrameSources` gives the iterated `values` of a program, as written. */
  function iterated(declarations: string, type: string): readonly string[] {
    using parsed = api.createSourceFile(
      'iteration-places.ts',
      `${declarations}\nfunction frames(values: ${type}) { let e: unknown = 0; for (e of values) {} return e; }\n`,
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

  it.each(CASES)('reads $what', ({ type, sources }) => {
    expect(iterated('', type)).toStrictEqual(sources);
  });

  it.each(DECLARED)('reads $what', ({ declarations, sources }) => {
    expect(iterated(declarations, 'Values')).toStrictEqual(sources);
  });
});
