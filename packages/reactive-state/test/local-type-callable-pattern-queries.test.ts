import { isFunctionTypeNode, isTypeQueryNode, type Node, type TypeQueryNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { callableQueryReading } from '../src/compiler/local-type-callable-queries.ts';
import { initialTypeReading } from '../src/compiler/local-type-environment.ts';

/**
 * `typeof name` of a name a pattern takes apart reads what the pattern selects, not the whole it
 * is taken apart of: neither the type written for the whole, nor what the whole is declared of —
 * the reading of a callable's query reads neither, as it reads no member of a whole. A name a
 * declaration binds whole is still read of its annotation, or of the function it is declared of.
 * The rows marked a pin read the same before the change as after it.
 */

const CASES = [
  {
    read: undefined,
    source: 'function g({ f }: { f: () => string }) { type T = typeof f; }',
    what: 'a parameter taken apart',
  },
  {
    read: undefined,
    source: 'const { f }: { f: () => string } = { f: () => "x" }; type T = typeof f;',
    what: 'a constant taken apart',
  },
  {
    read: undefined,
    source:
      'const other: { f: () => number } & (() => string) = Object.assign(() => "x", { f: () => 1 }); const { f } = other; type T = typeof f;',
    what: 'a name taken apart of an alias',
  },
  {
    read: undefined,
    source: 'function g([first, f]: [() => number, () => string]) { type T = typeof f; }',
    what: 'an element of a tuple taken apart',
  },
  {
    read: undefined,
    source:
      'function g({ first, ...rest }: { first: () => number; f: () => string }) { type T = typeof rest; }',
    what: 'a rest taken apart',
  },
  {
    read: '() => string',
    source: 'function g(f: () => string) { type T = typeof f; }',
    what: 'a parameter whole (pin)',
  },
  {
    read: '() => string',
    source: 'const f: () => string = () => "x"; type T = typeof f;',
    what: 'a constant whole (pin)',
  },
  {
    read: 'number',
    source: 'const f = (): number => 1; const g = f; type T = typeof g;',
    what: 'an alias of a function (pin)',
  },
] as const;

describe('a callable query of a name a pattern takes apart', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The text of the type the callable query in `source` reads, or the result of the one it reads. */
  function readingOf(source: string): string | undefined {
    using parsed = api.createSourceFile('local-type.ts', source);
    let query: TypeQueryNode | undefined;
    const visit = (node: Node): void => {
      if (isTypeQueryNode(node)) {
        query = node;
      }
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (query === undefined) {
      throw new Error(`No query is written in ${source}.`);
    }
    const reading = callableQueryReading(initialTypeReading(query));
    if (reading === undefined) {
      return undefined;
    }
    const { type } = reading;
    // A written function's signature is made anew, of no text: its result is the declaration's.
    if (type.pos < 0) {
      return isFunctionTypeNode(type) ? type.type?.getText(parsed.sourceFile) : 'a type made anew';
    }
    return type.getText(parsed.sourceFile);
  }

  it.each(CASES)('$what', ({ read, source }) => {
    expect(readingOf(source)).toBe(read);
  });
});
