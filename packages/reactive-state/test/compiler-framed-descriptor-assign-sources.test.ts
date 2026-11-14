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
    id: 'unread-spread-then-literal',
    source: 'Object.assign(d, ...extras, { value: e });',
    values: ['e'],
  },
  {
    id: 'two-unread-spreads-then-literal',
    source: 'Object.assign(d, ...extras, ...more, { value: e });',
    values: ['e'],
  },
  {
    id: 'literal-spread-literal',
    source: 'Object.assign(d, { value: first }, ...extras, { value: e });',
    values: ['first', 'e'],
  },
  {
    id: 'unread-spread-in-a-written-list',
    source: 'Object.assign(d, ...[{ value: first }, ...extras, { value: e }]);',
    values: ['first', 'e'],
  },
  {
    id: 'unread-spread-in-the-target-list',
    source: 'Object.assign(...[d, ...extras, { value: e }]);',
    values: ['e'],
  },
  {
    id: 'held-list-then-unread-spread',
    source: 'const held = [{ value: first }]; Object.assign(d, ...held, ...extras, { value: e });',
    values: ['first', 'e'],
  },
  {
    id: 'written-list-spread-pin',
    source: 'Object.assign(d, ...[{ value: first }, ...[{ value: e }]]);',
    values: ['first', 'e'],
  },
  {
    id: 'trailing-unread-spread-pin',
    source: 'Object.assign(d, { value: e }, ...extras);',
    values: ['e'],
  },
  {
    id: 'unread-spread-before-the-target',
    source: 'Object.assign(...extras, d, { value: e });',
    values: [],
  },
  {
    id: 'unread-spread-before-a-literal',
    source: 'Object.assign(...extras, { value: e });',
    values: [],
  },
  {
    id: 'member-write-before-the-call',
    source: 'const overrides = { value: first }; overrides.value = e; Object.assign(d, overrides);',
    values: ['first', 'e'],
  },
  {
    id: 'member-write-in-a-later-argument',
    source:
      'const overrides = { value: first }; Object.assign(d, overrides, { other: (overrides.value = e) });',
    values: ['first', 'e'],
  },
  {
    id: 'member-write-after-the-call',
    source: 'const overrides = { value: first }; Object.assign(d, overrides); overrides.value = e;',
    values: ['first', 'e'],
  },
  {
    id: 'member-write-through-an-alias',
    source:
      'const overrides = { value: first }; const copy = overrides; copy.value = e; Object.assign(d, overrides);',
    values: ['first', 'e'],
  },
  {
    id: 'source-alias-written-through-the-original',
    source:
      'const base = { value: first }; const alias = base; base.value = e; Object.assign(d, alias);',
    values: ['first', 'e'],
  },
  {
    id: 'member-write-by-a-computed-name',
    source: 'const overrides = { value: first }; overrides[name] = e; Object.assign(d, overrides);',
    values: ['first', 'e'],
  },
  {
    id: 'logical-assignment-to-the-member',
    source:
      'const overrides = { value: first }; overrides.value ??= e; Object.assign(d, overrides);',
    values: ['first', 'e'],
  },
  {
    id: 'object-assign-into-the-source',
    source:
      'const overrides = { value: first }; Object.assign(overrides, { value: e }); Object.assign(d, overrides);',
    values: ['first', 'e'],
  },
  {
    id: 'spread-of-a-written-alias',
    source: 'const inner = { value: first }; inner.value = e; Object.assign(d, { ...inner });',
    values: ['first', 'e'],
  },
  {
    id: 'object-assign-into-the-source-by-a-list',
    source:
      'const overrides = { value: first }; Object.assign(...[overrides, { value: e }]); Object.assign(d, overrides);',
    values: ['first', 'e'],
  },
  {
    id: 'object-assign-into-the-source-by-an-unread-list-pin',
    source:
      'const overrides = { value: first }; Object.assign(...extras, overrides, { value: e }); Object.assign(d, overrides);',
    values: ['first'],
  },
  {
    id: 'logical-assignment-to-the-descriptor',
    source: 'd.value ??= e;',
    values: ['e'],
  },
  {
    id: 'sources-that-write-each-other',
    source:
      'const a = { value: first }; const b = { value: e }; Object.assign(a, b); Object.assign(b, a); Object.assign(d, a);',
    values: ['first', 'e'],
  },
  {
    id: 'source-handed-to-a-call-pin',
    source: 'const overrides = { value: first }; mutate(overrides); Object.assign(d, overrides);',
    values: ['first'],
  },
  {
    id: 'source-as-a-loop-target-pin',
    source:
      'const overrides = { value: first }; for (overrides.value of errors) use(1); Object.assign(d, overrides);',
    values: ['first'],
  },
  {
    id: 'source-member-deleted-pin',
    source:
      'const overrides = { value: first }; delete overrides.value; Object.assign(d, overrides);',
    values: ['first'],
  },
  {
    id: 'arithmetic-compound-write-pin',
    source:
      "const overrides = { value: first }; overrides.value += 'text'; Object.assign(d, overrides);",
    values: ['first'],
  },
  {
    id: 'another-member-written-pin',
    source: 'const overrides = { value: first }; overrides.other = e; Object.assign(d, overrides);',
    values: ['first'],
  },
  {
    id: 'source-only-read-pin',
    source:
      'const overrides = { value: first }; use(overrides.value); const copy = overrides; const again = { ...overrides }; Object.assign(d, overrides);',
    values: ['first'],
  },
  {
    id: 'parameter-of-the-same-name-pin',
    source:
      'const overrides = { value: first }; function patch(overrides: { value: Error }) { overrides.value = e; } Object.assign(d, overrides);',
    values: ['first'],
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
      `declare const source: object; declare const e: Error; declare const first: Error; declare const extra: object; declare const extras: object[]; declare const more: object[]; declare const other: object; declare const name: string; declare function make(): object; declare const errors: Error[]; declare function mutate(value: object): void; declare function use(value: unknown): void;\n${DESCRIBED}\n${source}\nuse(d.value);`,
    );
    const read = descriptorRead(parsed.sourceFile);

    const written = [...new Set(framedDescriptorWrites(read).map((each) => each.getText()))];

    expect(written.toSorted(byText)).toStrictEqual(values.toSorted(byText));
  });
});

function byText(left: string, right: string): number {
  return left.localeCompare(right);
}

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
