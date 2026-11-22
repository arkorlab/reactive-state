import { type CallExpression, isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedNativeArguments } from '../src/compiler/framed-native-arguments.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A native called through `.call` consumes the arguments after its receiver, all of them: a native
 * that takes any number (`push`, `splice`, `Object.assign`) is handed the fourth and the fifth as it
 * is the first, and what a reader of the call sees of them must not stop at a window of the call's
 * own arguments. A list the call spreads, written in place or by a whole constant, gives its entries
 * the same way; one the code cannot read stays unknown. `.apply` and `Reflect` hand a list whole.
 */
const NAMES = new Set(['Array.prototype.push', 'Array.prototype.splice', 'Error', 'Object.assign']);

const CASES = [
  {
    id: 'call-with-three-arguments-pin',
    source: 'Array.prototype.push.call(list, first, second, third);',
    args: ['first', 'second', 'third'],
  },
  {
    id: 'call-with-four-arguments',
    source: 'Array.prototype.push.call(list, first, second, third, fourth);',
    args: ['first', 'second', 'third', 'fourth'],
  },
  {
    id: 'call-with-seven-arguments',
    source: 'Array.prototype.push.call(list, a, b, c, d, e, f);',
    args: ['a', 'b', 'c', 'd', 'e', 'f'],
  },
  {
    id: 'call-of-object-assign',
    source: 'Object.assign.call(null, target, first, second, third);',
    args: ['target', 'first', 'second', 'third'],
  },
  {
    id: 'call-of-splice',
    source: 'Array.prototype.splice.call(list, 0, 0, first, second);',
    args: ['0', '0', 'first', 'second'],
  },
  {
    id: 'call-of-error-with-extra-arguments',
    source: "Error.call(null, 'message', { cause }, extra, more);",
    args: ["'message'", '{ cause }', 'extra', 'more'],
  },
  {
    id: 'call-with-a-spread-of-a-written-list',
    source: 'Array.prototype.push.call(list, ...[a, b, c, d, e]);',
    args: ['a', 'b', 'c', 'd', 'e'],
  },
  {
    id: 'call-with-a-spread-of-a-whole-constant',
    source: 'const values = [a, b, c, d, e]; Array.prototype.push.call(list, ...values);',
    args: ['a', 'b', 'c', 'd', 'e'],
  },
  {
    id: 'call-with-a-spread-beside-arguments',
    source: 'Array.prototype.push.call(list, first, ...[second, third], fourth);',
    args: ['first', 'second', 'third', 'fourth'],
  },
  {
    id: 'call-with-the-receiver-spread',
    source: 'Array.prototype.push.call(...[list, a, b, c, d]);',
    args: ['a', 'b', 'c', 'd'],
  },
  {
    id: 'call-with-no-arguments-after-the-receiver-pin',
    source: 'Array.prototype.push.call(list);',
    args: [],
  },
  {
    id: 'call-with-an-unreadable-spread',
    source: 'Array.prototype.push.call(list, ...rest);',
    args: undefined,
  },
  {
    id: 'call-with-an-unreadable-spread-after-four',
    source: 'Array.prototype.push.call(list, a, b, c, d, ...rest);',
    args: undefined,
  },
  {
    id: 'call-without-a-receiver-pin',
    source: 'Array.prototype.push.call();',
    args: undefined,
  },
  {
    id: 'apply-with-a-list-pin',
    source: 'Array.prototype.push.apply(list, [a, b, c, d, e]);',
    args: ['a', 'b', 'c', 'd', 'e'],
  },
  {
    id: 'reflect-apply-with-a-list-pin',
    source: 'Reflect.apply(Array.prototype.push, list, [a, b, c, d, e]);',
    args: ['a', 'b', 'c', 'd', 'e'],
  },
  {
    id: 'direct-call-pin',
    source: 'Error(a, b, c, d, e);',
    args: ['a', 'b', 'c', 'd', 'e'],
  },
] as const;

const DEPTHS = [1, 3, 12, 30] as const;

/** The one call of the source. */
function callOf(root: Node): CallExpression {
  const pending = [root];
  let found: CallExpression | undefined;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node) && !isCallExpression(node.parent)) found = node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  if (found === undefined) throw new Error('no call');
  return found;
}

describe('the arguments a native is called with through call', () => {
  it.each(CASES)('$id', ({ source, args }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'x.ts', source);
    const selected = framedNativeArguments(callOf(parsed.sourceFile), NAMES);

    expect(selected?.args?.map((each) => each.getText())).toStrictEqual(
      args === undefined ? undefined : [...args],
    );
  });
});

describe('a call that spreads a chain of constants that each spread the one before twice', () => {
  it.each(DEPTHS)('reads no list from the chain, at depth %i', (depth) => {
    const chain = Array.from(
      { length: depth },
      (_, at) => `const part${at + 1} = [...part${at}, ...part${at}];`,
    );
    const source = `function frames(list: unknown[], item: unknown) { const part0 = [item]; ${chain.join(' ')} Array.prototype.push.call(list, ...part${depth}); }`;
    using api = openTypeScript();
    using parsed = parseModule(api, 'x.ts', source);

    expect(framedNativeArguments(callOf(parsed.sourceFile), NAMES)?.args).toBeUndefined();
  });
});
