import { isFunctionDeclaration } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkContextDefaults } from '../src/compiler/middleware-alike.ts';
import { contextOf } from '../src/compiler/middleware-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * An array's pattern in a route middleware's context is written whole into each part that reads a
 * name of it — an object's pattern keeps only the names a part reads — so a default or a computed key
 * within it that is not computed alike is evaluated by both parts where both read a name of the array,
 * whichever name each reads. A default of literals, an array only one part reads, and an object's
 * pattern are taken.
 */

interface Row {
  readonly id: string;
  /** The context parameter. */
  readonly context: string;
  /** The names the guard reads, and the names the host reads. */
  readonly guard: readonly string[];
  readonly host: readonly string[];
}

const fail = (reason: string): never => {
  throw new Error(reason);
};

/** A default or a key evaluated by both parts, each of its own: refused. */
const BOTH: readonly Row[] = [
  {
    context: '{ params: { tags: [first, second = counter()] = [] } }',
    guard: ['first'],
    host: ['second'],
    id: 'guard-reads-the-first-slot-host-the-second',
  },
  {
    context: '{ params: { tags: [first, second = counter()] = [] } }',
    guard: ['second'],
    host: ['first'],
    id: 'guard-reads-the-second-slot-host-the-first',
  },
  {
    context: '{ params: { tags: [{ a = counter() }, b] = [{}] } }',
    guard: ['b'],
    host: ['a'],
    id: 'default-of-an-object-in-the-array',
  },
  {
    context: '{ params: { tags: [{ [counter()]: a }, b] = [{}] } }',
    guard: ['b'],
    host: ['a'],
    id: 'computed-key-of-an-object-in-the-array',
  },
  {
    context: '{ params: { tags: [[first, second = counter()], third] = [[]] } }',
    guard: ['third'],
    host: ['first'],
    id: 'array-in-an-array',
  },
  {
    context: '{ params: { tags: [first, second = counter()] = [] } }',
    guard: ['first', 'second'],
    host: ['second'],
    id: 'both-read-the-defaulted-name',
  },
];

/** What only one part evaluates, what is alike, and an object's pattern: taken. */
const ONE: readonly Row[] = [
  {
    context: '{ params: { tags: [first, second = 7] = [] } }',
    guard: ['first'],
    host: ['second'],
    id: 'default-of-a-literal',
  },
  {
    context: '{ params: { tags: [first, second = counter()] = [] } }',
    guard: [],
    host: ['first', 'second'],
    id: 'only-the-host-reads-the-array',
  },
  {
    context: '{ params: { tags: [first, second = counter()] = [] } }',
    guard: ['first', 'second'],
    host: [],
    id: 'only-the-guard-reads-the-array',
  },
  {
    context: '{ params: { projectId: a, other: b = counter() } }',
    guard: ['a'],
    host: ['b'],
    id: 'object-pattern-keeps-the-names-a-part-reads',
  },
  {
    context: '{ params: { other: { a = counter(), b } } }',
    guard: ['b'],
    host: ['a'],
    id: 'object-in-an-object',
  },
];

describe('a default within an array pattern of a route middleware’s context', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `checkContextDefaults` refuses of the context, or `undefined`. */
  function refused(row: Row): string | undefined {
    using file = parseModule(
      api,
      'middleware.ts',
      `export default function middleware(${row.context}, next) {}\n`,
    );
    const declared = file.sourceFile.statements.find((statement) =>
      isFunctionDeclaration(statement),
    );
    const [parameter] =
      declared !== undefined && isFunctionDeclaration(declared) ? declared.parameters : [];
    if (parameter === undefined) {
      throw new Error('The middleware has no context.');
    }
    try {
      checkContextDefaults(
        contextOf(parameter.name, fail),
        { guard: (name) => row.guard.includes(name), host: (name) => row.host.includes(name) },
        fail,
      );
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it.each(BOTH)('refuses a default both parts evaluate: $id', (row) => {
    expect(refused(row)).toContain('would be bound by each of them');
  });

  it.each(ONE)('takes what only one part evaluates, or is alike: $id', (row) => {
    expect(refused(row)).toBeUndefined();
  });
});
