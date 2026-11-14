import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall } from '../src/compiler/framed-entry-values.ts';
import { entriesRunCode } from '../src/compiler/framed-implicit-code.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `Object.fromEntries` takes the entries of its argument and converts the key of each to the name it
 * installs: the list it takes, an entry that is no list, and a key that may be an object (which a
 * `toString`, a `valueOf` or a `Symbol.toPrimitive` converts) run code of the program's, where a name
 * a list is held by is written as a whole elsewhere, the list it holds is not the one it was given.
 */
const CASES = [
  {
    id: 'lists-written-out',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { const held: [string, number] = ['a', 1]; return Object.fromEntries([held, ['b', 2]]); }`,
    runs: false,
  },
  {
    id: 'list-held-by-a-constant-with-a-text-key',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { const held = ['a', 1]; return Object.fromEntries([held]); }`,
    runs: false,
  },
  {
    id: 'list-held-by-a-name-written-as-a-whole',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { let held: any = ['a', 1]; held = { get 0() { return 'b'; }, 1: 2 }; return Object.fromEntries([held]); }`,
    runs: true,
  },
  {
    id: 'list-held-by-a-name-assigned-in-a-branch',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { let held: any = ['a', 1]; if (flag) held = {}; return Object.fromEntries([held]); }`,
    runs: true,
  },
  {
    id: 'list-held-by-a-name-assigned-in-a-loop',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { let held: any = ['a', 1]; for (const each of [1]) { held = each; } return Object.fromEntries([held]); }`,
    runs: true,
  },
  {
    id: 'list-held-by-a-name-of-an-unwritten-let-pin',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { let held: [string, number] = ['a', 1]; return Object.fromEntries([held]); }`,
    runs: false,
  },
  {
    id: 'object-as-the-key',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries([[{}, 1]]); }`,
    runs: true,
  },
  {
    id: 'object-with-a-hook-as-the-key-of-a-held-list',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { const held = [{ toString() { return 'a'; } }, 1]; return Object.fromEntries([held]); }`,
    runs: true,
  },
  {
    id: 'name-of-an-unknown-type-as-the-key',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries([[key, 1]]); }`,
    runs: true,
  },
  {
    id: 'name-of-a-string-type-as-the-key',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries([[name, 1]]); }`,
    runs: false,
  },
  {
    id: 'name-of-a-number-type-as-the-key',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries([[count, 1]]); }`,
    runs: false,
  },
  {
    id: 'name-of-a-literal-type-as-the-key',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { const word: 'a' | 'b' = flag ? 'a' : 'b'; return Object.fromEntries([[word, 1]]); }`,
    runs: false,
  },
  {
    id: 'text-written-out-as-the-key',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries([['a', 1]]); }`,
    runs: false,
  },
  {
    id: 'template-written-out-as-the-key',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries([[\`a\`, 1]]); }`,
    runs: false,
  },
  {
    id: 'constant-text-as-the-key',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { const label = 'a'; return Object.fromEntries([[label, 1]]); }`,
    runs: false,
  },
  {
    id: 'undefined-as-the-key',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries([[undefined, 1]]); }`,
    runs: false,
  },
  {
    id: 'spread-in-an-entry',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries([[...'ab']]); }`,
    runs: true,
  },
  {
    id: 'spread-of-a-list-written-out',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries([...[['a', 1]]]); }`,
    runs: false,
  },
  {
    id: 'spread-of-a-name',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries([...rows]); }`,
    runs: true,
  },
  {
    id: 'entry-given-by-a-name-of-an-unknown-value',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries([row]); }`,
    runs: true,
  },
  {
    id: 'object-as-an-entry',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries([{ 0: 'a', 1: 1 }]); }`,
    runs: true,
  },
  {
    id: 'list-that-is-no-list-written-out',
    source: `function frames(error: Error, flag: boolean, name: string, count: number, key: unknown, row: any, rows: any) { return Object.fromEntries(rows); }`,
    runs: true,
  },
] as const;

describe('the entries Object.fromEntries takes', () => {
  it.each(CASES)('$id', ({ source, runs }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'implicit-code-entries.ts', source);

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
