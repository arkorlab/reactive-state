import { type CallExpression, isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { calledNative } from '../src/compiler/framed-native-calls.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A native called with a spread of a list is read with the entries the list stands for, but a list
 * that other code mentions before the call may have been changed, and is no list to expand
 * (`framedAppliedArguments`). A chain of constants that each spread the one before twice, which
 * would grow as two to the power of its length if each were expanded, is so expanded one level: the
 * first constant is mentioned by the spreads that build the next.
 */
const CALLS = [
  { id: 'spread', call: (name: string) => `Object.assign(target, ...${name})` },
  { id: 'apply', call: (name: string) => `Object.assign.apply(null, [target, ...${name}])` },
  {
    id: 'reflect-apply',
    call: (name: string) => `Reflect.apply(Object.assign, null, [target, ...${name}])`,
  },
] as const;

const DEPTHS = [1, 3, 12, 30] as const;

const NATIVES = ['Object.assign', 'Reflect.apply'] as const;

describe('a chain of constants that each spread the one before twice', () => {
  describe.each(CALLS)('$id', ({ call }) => {
    it.each(DEPTHS)('is expanded one level, at depth %i', (depth) => {
      const chain = Array.from(
        { length: depth },
        (_, at) => `const a${at + 1} = [...a${at}, ...a${at}];`,
      );
      const last = `a${depth}`;
      const source = `function frames(target: any) { const a0 = [{}]; ${chain.join(' ')} ${call(last)}; }`;

      expect(argumentsOf(source)).toStrictEqual(['target', `...a${depth - 1}`, `...a${depth - 1}`]);
    });
  });

  it('a list nothing else mentions is expanded, as written', () => {
    const source =
      'function frames(target: any) { const list = [{ a: 1 }, { b: 2 }]; Object.assign(target, ...list); }';

    expect(argumentsOf(source)).toStrictEqual(['target', '{ a: 1 }', '{ b: 2 }']);
  });

  it('a list that is mentioned before the call is not, the one that spreads it is', () => {
    const source =
      'function frames(target: any) { const list = [{ a: 1 }]; const copy = [...list]; Object.assign(target, ...list, ...copy); }';

    expect(argumentsOf(source)).toStrictEqual(['target', '...list', '...list']);
  });
});

/** The arguments the call of `Object.assign` in the source is read to be given. */
function argumentsOf(source: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'native-calls-expansion.ts', source);
  const call = nativeCall(parsed.sourceFile);
  return calledNative(call, new Set(['Object.assign']))?.args.map((each) => each.getText());
}

function nativeCall(root: Node): CallExpression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node) && NATIVES.some((each) => node.getText().startsWith(each)))
      return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no call of a native');
}
