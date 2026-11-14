import {
  type CallExpression,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Expression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedDescriptorWrites } from '../src/compiler/framed-descriptor-writes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * An `Object.assign` source writes its own `value` into the descriptor. What the walk reads of it:
 * a literal, or the literal a whole constant alias chain ends in, and the literals it spreads; the
 * entries a literal writes that may be named `value` stay possible values where another part of the
 * source (a spread it cannot read, a computed name it cannot read) is not read, which adds nothing
 * and takes nothing away. A source it cannot read at all (a parameter, a call, a variable assigned
 * again) writes nothing the walk knows.
 */
const DESCRIBED = "const d = Object.getOwnPropertyDescriptor(source, 'x')!;";
const CASES = [
  {
    id: 'literal-then-spread',
    source: 'Object.assign(d, { value: e, ...extra });',
    values: ['e'],
  },
  {
    id: 'spread-then-literal',
    source: 'Object.assign(d, { ...extra, value: e });',
    values: ['e'],
  },
  {
    id: 'unknown-computed-name',
    source: 'Object.assign(d, { [name]: e });',
    values: ['e'],
  },
  {
    id: 'unknown-computed-name-after-value',
    source: 'Object.assign(d, { value: first, [name]: e });',
    values: ['first', 'e'],
  },
  {
    id: 'shorthand-with-spread',
    source: 'Object.assign(d, { e, value: e, ...extra });',
    values: ['e'],
  },
  {
    id: 'constant-alias',
    source: 'const overrides = { value: e }; Object.assign(d, overrides);',
    values: ['e'],
  },
  {
    id: 'constant-alias-chain',
    source: 'const base = { value: e }; const alias = base; Object.assign(d, alias);',
    values: ['e'],
  },
  {
    id: 'constant-alias-with-spread',
    source: 'const overrides = { value: e, ...extra }; Object.assign(d, overrides);',
    values: ['e'],
  },
  {
    id: 'spread-of-an-alias',
    source: 'const inner = { value: e }; Object.assign(d, { ...inner });',
    values: ['e'],
  },
  {
    id: 'spread-of-a-literal',
    source: 'Object.assign(d, { ...{ value: e } });',
    values: ['e'],
  },
  {
    id: 'argument-list-spread',
    source: 'Object.assign(...[d, { value: e }]);',
    values: ['e'],
  },
  {
    id: 'spread-of-the-same-alias-twice',
    source: 'const inner = { value: e }; Object.assign(d, { ...inner, ...inner });',
    values: ['e'],
  },
  {
    id: 'later-source-unread',
    source: 'Object.assign(d, { value: e }, other);',
    values: ['e'],
  },
  {
    id: 'plain-literal',
    source: 'Object.assign(d, { value: e });',
    values: ['e'],
  },
  {
    id: 'parameter-source',
    source: 'function patch(overrides: PropertyDescriptor) { Object.assign(d, overrides); }',
    values: [],
  },
  {
    id: 'call-source',
    source: 'Object.assign(d, make());',
    values: [],
  },
  {
    id: 'spread-variable',
    source: 'Object.assign(d, { ...other });',
    values: [],
  },
  {
    id: 'assigned-again-variable',
    source: 'let overrides = { value: e }; overrides = other; Object.assign(d, overrides);',
    values: [],
  },
  {
    id: 'other-name-with-spread',
    source: 'Object.assign(d, { writable: false, ...extra });',
    values: [],
  },
  {
    id: 'accessor-value-with-spread',
    source: 'Object.assign(d, { get value() { return e; }, ...extra });',
    values: [],
  },
  {
    id: 'another-descriptor',
    source:
      "const o = Object.getOwnPropertyDescriptor(source, 'y')!; Object.assign(o, { value: e, ...extra });",
    values: [],
  },
] as const;

describe('native Object.assign sources written into a descriptor', () => {
  it.each(CASES)('$id', ({ source, values }) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'descriptor-assign-sources.ts',
      `declare const source: object; declare const e: Error; declare const first: Error; declare const extra: object; declare const other: object; declare const name: string; declare function make(): object; declare function use(value: unknown): void;\n${DESCRIBED}\n${source}\nuse(d.value);`,
    );
    const read = descriptorRead(parsed.sourceFile);

    expect(framedDescriptorWrites(read).map((each) => each.getText())).toStrictEqual(values);
  });
});

/** The descriptor name in the `use(name.value)` that reads it. */
function descriptorRead(root: Node): Expression {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const read = isCallExpression(node) ? usedDescriptor(node) : undefined;
    if (read !== undefined) return read;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no use(descriptor.value) call');
}

function usedDescriptor(call: CallExpression): Expression | undefined {
  const [argument] = call.arguments;
  if (argument === undefined || !isPropertyAccessExpression(argument)) return undefined;
  return isIdentifier(call.expression) && call.expression.text === 'use'
    ? argument.expression
    : undefined;
}
