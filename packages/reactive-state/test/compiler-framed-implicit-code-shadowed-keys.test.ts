import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall } from '../src/compiler/framed-entry-values.ts';
import { entriesRunCode } from '../src/compiler/framed-implicit-code.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `undefined`, `NaN` and `Infinity` are the language's own primitives where nothing declares them in the
 * scope they are read in, and the key of an entry that is one converts to a text with no code of the
 * program's run. A name the code declares that is spelled so is any value its declaration gives it, an
 * object whose `toString` the call runs among them.
 */
const CASES = [
  {
    id: 'shadowed-undefined-holds-an-object',
    source: `function frames(error: Error) { const undefined = { toString() { return 'a'; } }; return Object.fromEntries([[undefined, 1]]); }`,
    runs: true,
  },
  {
    id: 'shadowed-undefined-in-a-block',
    source: `function frames(error: Error) { { const undefined = { toString() { return 'a'; } }; return Object.fromEntries([[undefined, 1]]); } }`,
    runs: true,
  },
  {
    id: 'shadowed-undefined-by-a-variable',
    source: `function frames(error: Error) { var undefined: any = { toString() { return 'a'; } }; return Object.fromEntries([[undefined, 1]]); }`,
    runs: true,
  },
  {
    id: 'shadowed-undefined-by-a-parameter',
    source: `function frames(error: Error) { return ((undefined: any) => Object.fromEntries([[undefined, 1]]))({ toString() { return 'a'; } }); }`,
    runs: true,
  },
  {
    id: 'shadowed-undefined-by-a-function',
    source: `function frames(error: Error) { function undefined() {} return Object.fromEntries([[undefined, 1]]); }`,
    runs: true,
  },
  {
    id: 'shadowed-undefined-by-a-class',
    source: `function frames(error: Error) { class undefined {} return Object.fromEntries([[undefined, 1]]); }`,
    runs: true,
  },
  {
    id: 'shadowed-nan-holds-an-object',
    source: `function frames(error: Error) { const NaN = { toString() { return 'a'; } }; return Object.fromEntries([[NaN, 1]]); }`,
    runs: true,
  },
  {
    id: 'shadowed-infinity-holds-an-object',
    source: `function frames(error: Error) { const Infinity = { toString() { return 'a'; } }; return Object.fromEntries([[Infinity, 1]]); }`,
    runs: true,
  },
  {
    id: 'shadowed-undefined-held-by-an-entry-name',
    source: `function frames(error: Error) { const undefined = { toString() { return 'a'; } }; const row = [undefined, 1]; return Object.fromEntries([row]); }`,
    runs: true,
  },
  {
    id: 'shadowed-undefined-as-the-object-entry-key',
    source: `function frames(error: Error) { const undefined = { toString() { return 'a'; } }; return Object.fromEntries([{ 0: undefined, 1: 1 }]); }`,
    runs: true,
  },
  {
    id: 'global-undefined-pin',
    source: `function frames(error: Error) { return Object.fromEntries([[undefined, 1]]); }`,
    runs: false,
  },
  {
    id: 'global-nan-pin',
    source: `function frames(error: Error) { return Object.fromEntries([[NaN, 1]]); }`,
    runs: false,
  },
  {
    id: 'global-infinity-pin',
    source: `function frames(error: Error) { return Object.fromEntries([[Infinity, 1]]); }`,
    runs: false,
  },
  {
    id: 'global-this-undefined-pin',
    source: `function frames(error: Error) { return Object.fromEntries([[globalThis.undefined, 1]]); }`,
    runs: false,
  },
  {
    id: 'global-undefined-of-another-global-name-pin',
    source: `function frames(error: Error) { return Object.fromEntries([[window.undefined, 1]]); }`,
    runs: false,
  },
] as const;

describe("a key named as one of the language's own primitives", () => {
  it.each(CASES)('$id', ({ source, runs }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'shadowed-primitive-keys.ts', source);

    expect(entriesRunCode(entriesCall(parsed.sourceFile))).toBe(runs);
  });
});

function entriesCall(root: Node): CallExpression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node) && framedEntriesCall(node)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no Object.fromEntries call');
}
