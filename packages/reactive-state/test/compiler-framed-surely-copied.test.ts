import {
  type Expression,
  isObjectLiteralExpression,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { copiedAfter, copyOrder, surelyCopied } from '../src/compiler/framed-getter-writes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The names a spread of a written object surely copies: those it has, a setter's among them, and those of
 * the spreads it holds, but for the names a getter among its fields may delete before the copy reaches
 * them. The order of a copy: array indices first, in order, then the other names as first written.
 */
const COPIED = [
  { id: 'fields', source: '({ a: 1, b: 2 })', names: ['a', 'b'] },
  {
    id: 'a-setter-is-copied-as-data',
    source: '({ set a(v: unknown) {}, b: 2 })',
    names: ['a', 'b'],
  },
  { id: 'a-held-spread', source: '({ a: 1, ...{ b: 2 } })', names: ['a', 'b'] },
  {
    id: 'a-getter-that-deletes-a-name',
    source: '({ get zap() { delete this.a; return 0; }, a: 1, b: 2 })',
    names: ['b', 'zap'],
  },
  {
    id: 'a-getter-that-gives-this-on',
    source: '({ get zap() { hand(this); return 0; }, a: 1 })',
    names: [],
  },
  { id: 'a-spread-of-a-name', source: '({ a: 1, ...other })', names: ['a'] },
  { id: 'no-written-object', source: 'other', names: [] },
] as const;

describe('the names a spread surely copies', () => {
  it.each(COPIED)('$id', ({ source, names }) => {
    expect([...copied(source)].toSorted((one, two) => one.localeCompare(two))).toStrictEqual(names);
  });

  it('nested literals with a getter, a setter and a spread of the next are judged once each', () => {
    let nested = '{ activate: 0 }';
    for (let depth = 0; depth < 30; depth += 1)
      nested = `{ get tick() { return 0; }, set activate(value: unknown) {}, ...${nested} }`;

    expect(copied(`(${nested})`).has('activate')).toBe(true);
  });
});

const ORDERS = [
  { id: 'indices-first', source: '({ b: 1, 2: 1, a: 1, 1: 1 })', order: ['1', '2', 'b', 'a'] },
  {
    id: 'a-large-integer-is-an-ordinary-name',
    source: '({ b: 1, 4294967295: 1, 3: 1 })',
    order: ['3', 'b', '4294967295'],
  },
  {
    id: 'a-name-written-twice-keeps-its-place',
    source: '({ a: 1, b: 2, a: 3 })',
    order: ['a', 'b'],
  },
  { id: 'a-spread-of-a-written-object', source: '({ a: 1, ...{ b: 2 } })', order: ['a', 'b'] },
  { id: 'a-spread-of-a-name-is-unknown', source: '({ a: 1, ...other })', order: undefined },
  { id: 'a-computed-name-is-unknown', source: '({ [key]: 1 })', order: undefined },
] as const;

describe('the order a copy reaches names in', () => {
  it.each(ORDERS)('$id', ({ source, order }) => {
    const object = literal(source);

    expect(copyOrder(object)).toStrictEqual(order);
  });

  it('reaches a field after the getter that comes before it', () => {
    const order = copyOrder(literal('({ get trigger() { return 0; }, field: 1 })'));

    expect(copiedAfter(order, 'trigger', 'field')).toBe(true);
    expect(copiedAfter(order, 'field', 'trigger')).toBe(false);
    expect(copiedAfter(order, 'trigger', 'absent')).toBe(false);
    expect(copiedAfter(undefined, 'trigger', 'absent')).toBe(true);
  });
});

const PRELUDE =
  'declare const other: any; declare const key: string; declare function hand(x: unknown): void;';

function copied(source: string): ReadonlySet<string> {
  using api = openTypeScript();
  using parsed = parseModule(api, 'surely-copied.ts', `${PRELUDE} const target = ${source};`);
  return surelyCopied(target(parsed.sourceFile));
}

function literal(source: string): ObjectLiteralExpression {
  using api = openTypeScript();
  using parsed = parseModule(api, 'copy-order.ts', `${PRELUDE} const target = ${source};`);
  const found = unwrapped(target(parsed.sourceFile));
  if (!isObjectLiteralExpression(found)) throw new Error('no object literal');
  return found;
}

/** The initializer of the constant `target`. */
function target(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isVariableDeclaration(node) &&
      node.name.getText() === 'target' &&
      node.initializer !== undefined
    )
      return node.initializer;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no target');
}
