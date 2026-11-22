import {
  type Expression,
  isArrayBindingPattern,
  isCallExpression,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { consumedNextFunction } from '../src/compiler/throw-next.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Row {
  readonly id: string;
  /** The preceding statements of the module, and then the consumption. */
  readonly before: string;
  readonly consumer: string;
  /** Whether the consumption is an array binding rather than a call. */
  readonly binding?: boolean;
}

const SOURCE = "{ [Symbol.iterator]() { return { next() { throw new Error('n'); } }; } }";

/** `Iterator.from` obtains the iterator and reads `next` without calling it, in Node 26.13.1 alike. */
const ONLY_OBTAINED: readonly Row[] = [
  { id: 'Iterator.from written out', before: '', consumer: `Iterator.from(${SOURCE});` },
  {
    id: 'an array binding with no element',
    before: '',
    consumer: `const [] = ${SOURCE};`,
    binding: true,
  },
];

/** The same call through a constant that holds `Iterator.from`. */
const KEPT_UNDER_A_NAME: readonly Row[] = [
  {
    id: 'a constant that holds Iterator.from',
    before: 'const from = Iterator.from;',
    consumer: `from(${SOURCE});`,
  },
  {
    id: 'a constant that holds a constant that holds Iterator.from',
    before: 'const first = Iterator.from; const from = first;',
    consumer: `from(${SOURCE});`,
  },
];

/** What a native consumer obtains and then steps, or what the code does not show as one. */
const STEPPED: readonly Row[] = [
  { id: 'Array.from written out', before: '', consumer: `Array.from(${SOURCE});` },
  {
    id: 'a constant that holds Array.from',
    before: 'const stepped = Array.from;',
    consumer: `stepped(${SOURCE});`,
  },
  {
    id: 'an array binding of one element',
    before: '',
    consumer: `const [first] = ${SOURCE};`,
    binding: true,
  },
];

const NOT_A_CONSUMER: readonly Row[] = [
  {
    id: 'a constant that holds another function',
    before: 'const from = (value: unknown) => value;',
    consumer: `from(${SOURCE});`,
  },
  {
    id: 'a name that is assigned again',
    before: 'let from = Iterator.from; from = Array.from;',
    consumer: `from(${SOURCE});`,
  },
  {
    id: 'a constant that holds Iterator.from, with a call between',
    before: 'const from = Iterator.from; declare function change(): void; change();',
    consumer: `from(${SOURCE});`,
  },
];

type Resolver = Parameters<typeof consumedNextFunction>[1];

/** What the callers hand: nothing, or a reader that answers for no name the module asks. */
const RESOLVERS: readonly (readonly [string, Resolver])[] = [
  ['no resolver', undefined],
  ['a resolver that knows no name', (name) => new Map<string, Expression>().get(name.text)],
];

/** Each row with each resolver, named by both. */
function withResolvers(rows: readonly Row[]): readonly (readonly [string, Row, Resolver])[] {
  return rows.flatMap((row) =>
    RESOLVERS.map(([how, resolve]) => [`${row.id} (${how})`, row, resolve] as const),
  );
}

describe('the next function a native consumer steps', () => {
  it.each(withResolvers(KEPT_UNDER_A_NAME))(
    'is none for %s, as for the written form',
    (_id, row, resolve) => {
      expect(nextOf(row, resolve)).toBeUndefined();
    },
  );

  it.each(withResolvers(ONLY_OBTAINED))('is none for %s', (_id, row, resolve) => {
    expect(nextOf(row, resolve)).toBeUndefined();
  });

  it.each(withResolvers(STEPPED))('is the method of %s', (_id, row, resolve) => {
    expect(nextOf(row, resolve)).toBe('next');
  });

  it.each(withResolvers(NOT_A_CONSUMER))('is none for %s', (_id, row, resolve) => {
    expect(nextOf(row, resolve)).toBeUndefined();
  });
});

/** The name of the function `consumedNextFunction` selects for the last consumption of the source. */
function nextOf(row: Row, resolve: Resolver): string | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'iterator-from.ts', `${row.before}\n${row.consumer}`);
  const found = lastConsumption(parsed.sourceFile, row.binding === true);
  if (found === undefined) {
    throw new Error('The fixture consumes an iterator.');
  }
  const next = consumedNextFunction(found, resolve);
  return next === undefined ? undefined : next.getText(parsed.sourceFile).slice(0, 'next'.length);
}

/** The last call, or the last array binding, of a source. */
function lastConsumption(node: Node, binding: boolean): Node | undefined {
  let found: Node | undefined;
  const visit = (each: Node): void => {
    const consumes = binding
      ? isVariableDeclaration(each) && isArrayBindingPattern(each.name)
      : isCallExpression(each);
    found = consumes ? each : found;
    each.forEachChild(visit);
  };
  visit(node);
  return found;
}
