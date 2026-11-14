import { isFunctionDeclaration, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { namesLocalMemberType } from '../src/compiler/local-type-reading.ts';

/**
 * A type query that a type it reaches queries again, `declare const value: { e: typeof value.e }`,
 * is read once: the query is the same node read in the same arguments, and its reading is cut
 * wherever a member or an element selected of what it read leads back to it — through a type alias,
 * an interface, a native wrapper, a tuple, an index, or constants that query one another. TypeScript
 * reports such a declaration as an error, which the compile does not wait for, so the reading ends by
 * itself as one that reads an alias again does, and takes an `Error` that stands beside the cycle.
 * A query read again by a path that selects a member of it is no cycle: `typeof v.self.self.e` of an
 * interface that holds `self: typeof v` reads as often as the path goes, and reaches the error. The
 * rows marked a pin answer the same before the change as after it. Before it a row that reads its own
 * query ran without end, or until the stack ended; here each reading of a value query is counted, and
 * one more than the bound is the end of it.
 */

const LIMIT = vi.hoisted(() => 200);
const reads = vi.hoisted(() => ({ calls: 0 }));

vi.mock(import('../src/compiler/local-type-value-queries.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    valueQueryReading: (...given: Parameters<typeof original.valueQueryReading>) => {
      reads.calls += 1;
      if (reads.calls > LIMIT) throw new Error('A value query is read again without end.');
      return original.valueQueryReading(...given);
    },
  };
});

const CASES = [
  {
    id: 'member-whose-type-is-its-own-query',
    names: false,
    source: 'declare const value: { e: typeof value.e };',
    type: 'typeof value.e',
  },
  {
    id: 'member-of-a-type-alias-that-queries-it',
    names: false,
    source: 'type A = { e: typeof a.e }; declare const a: A;',
    type: 'typeof a.e',
  },
  {
    id: 'member-of-an-interface-that-queries-it',
    names: false,
    source: 'interface I { e: typeof a.e } declare const a: I;',
    type: 'typeof a.e',
  },
  {
    id: 'two-constants-that-query-each-other',
    names: false,
    source: 'declare const a: { x: typeof b.x }; declare const b: { x: typeof a.x };',
    type: 'typeof a.x',
  },
  {
    id: 'three-constants-that-query-in-turn',
    names: false,
    source:
      'declare const a: { x: typeof b.x }; declare const b: { x: typeof c.x }; declare const c: { x: typeof a.x };',
    type: 'typeof a.x',
  },
  {
    id: 'nested-member-that-queries-itself',
    names: false,
    source: 'declare const value: { e: { f: typeof value.e.f } };',
    type: 'typeof value.e.f',
  },
  {
    id: 'nested-member-that-queries-the-member-above-pin',
    names: false,
    source: 'declare const value: { e: { f: typeof value.e } };',
    type: 'typeof value.e.f',
  },
  {
    id: 'member-in-a-native-wrapper',
    names: false,
    source: 'declare const value: Readonly<{ e: typeof value.e }>;',
    type: 'typeof value.e',
  },
  {
    id: 'member-picked-by-a-native-utility',
    names: false,
    source: 'declare const value: Pick<{ e: typeof value.e }, "e">;',
    type: 'typeof value.e',
  },
  {
    id: 'constant-the-query-names-by-an-alias',
    names: false,
    source: 'declare const value: { e: typeof other.e }; declare const other: typeof value;',
    type: 'typeof value.e',
  },
  {
    id: 'element-of-a-tuple-that-queries-it',
    names: false,
    source: 'declare const value: [(typeof value)[0]];',
    type: '(typeof value)[0]',
  },
  {
    id: 'member-indexed-by-its-key-that-queries-it',
    names: false,
    source: 'declare const value: { e: (typeof value)["e"] };',
    type: '(typeof value)["e"]',
  },
  {
    id: 'member-whose-selection-leads-back-to-the-query',
    names: false,
    source: 'declare const value: { e: typeof value.e.f };',
    type: 'typeof value.e',
  },
  {
    id: 'result-of-a-call-whose-member-queries-it',
    names: false,
    source: 'declare const value: { e: ReturnType<typeof value.e> };',
    type: 'typeof value.e',
  },
  {
    id: 'error-beside-the-cycle',
    names: true,
    source: 'declare const value: { e: typeof value.e | Error };',
    type: 'typeof value.e',
  },
  {
    id: 'error-beside-the-cycle-of-two-constants',
    names: true,
    source: 'declare const a: { x: typeof b.x | Error }; declare const b: { x: typeof a.x };',
    type: 'typeof a.x',
  },
  {
    id: 'error-a-member-holds-pin',
    names: true,
    source: 'declare const value: { e: Error };',
    type: 'typeof value.e',
  },
  {
    id: 'error-a-constant-aliased-holds-pin',
    names: true,
    source: 'declare const a: { e: Error }; declare const b: typeof a;',
    type: 'typeof b.e',
  },
  {
    id: 'error-after-one-step-through-the-query-pin',
    names: true,
    source: 'interface I { self: typeof v; e: Error } declare const v: I;',
    type: 'typeof v.self.e',
  },
  {
    id: 'error-after-two-steps-through-the-query-pin',
    names: true,
    source: 'interface I { self: typeof v; e: Error } declare const v: I;',
    type: 'typeof v.self.self.e',
  },
  {
    id: 'error-after-four-steps-through-the-query-pin',
    names: true,
    source: 'interface I { self: typeof v; e: Error } declare const v: I;',
    type: 'typeof v.self.self.self.self.e',
  },
  {
    id: 'error-after-two-steps-through-a-wrapped-query-pin',
    names: true,
    source: 'interface I { self: Readonly<typeof v>; e: Error } declare const v: I;',
    type: 'typeof v.self.self.e',
  },
  {
    id: 'error-after-two-steps-through-a-generic-interface-pin',
    names: true,
    source: 'interface I<T> { self: typeof v; e: T } declare const v: I<Error>;',
    type: 'typeof v.self.self.e',
  },
  {
    id: 'error-after-two-steps-through-an-inherited-query-pin',
    names: true,
    source: 'interface B { self: typeof v } interface I extends B { e: Error } declare const v: I;',
    type: 'typeof v.self.self.e',
  },
  {
    id: 'data-after-steps-through-the-query-pin',
    names: false,
    source: 'interface I { self: typeof v; e: Error; d: string } declare const v: I;',
    type: 'typeof v.self.self.d',
  },
] as const;

describe('a type query that a type it reaches queries again', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  beforeEach(() => {
    reads.calls = 0;
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `type`, a parameter's type written after `source`, names `Error`. */
  function namesError(source: string, type: string): boolean {
    using parsed = api.createSourceFile(
      'self-queries.ts',
      `${source}\nfunction frames(probe: ${type}) { return probe; }\n`,
    );
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error(`No parameter is declared of ${type}.`);
    return namesLocalMemberType(written, [], new Set(['Error']));
  }

  it.each(CASES)('$id', ({ names, source, type }) => {
    expect(namesError(source, type)).toBe(names);
    expect(reads.calls).toBeLessThanOrEqual(LIMIT);
  });
});
