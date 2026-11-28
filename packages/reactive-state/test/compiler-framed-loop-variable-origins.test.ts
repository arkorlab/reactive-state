import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

/**
 * A variable a `for…of` header declares holds what the loop iterates, as the variable of
 * `let each; for (each of list)` does: an error the list's declared type admits, or one it is written
 * with, is an error where the loop reads its frames and the words of one the code did not make. A
 * plain assignment of the variable, in a block around the read, replaces what the header gave it on
 * the member path read (`box = { … }; box.error.stack`); one that may not run, one after the read
 * and a write of a member into the variable do not, and a read of the whole variable is asked of
 * the header whatever was assigned to it, as it is of an initializer.
 */
const LIST = '[new Error("ours")]';

const CASES = [
  {
    id: 'parameter-list-stack',
    source:
      'function frames(input: Error[]) { for (const each of input) { return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'parameter-list-message',
    source:
      'function frames(input: Error[]) { let text = ""; for (const each of input) { text += each.message; } return text; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'parameter-list-text-conversion',
    source:
      'function frames(input: Error[]) { let text = ""; for (const each of input) { text += String(each); } return text; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'parameter-list-let-loop-variable',
    source:
      'function frames(input: Error[]) { for (let each of input) { return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'parameter-list-var-loop-variable',
    source:
      'function frames(input: Error[]) { for (var each of input) { return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'parameter-list-for-await',
    source:
      'async function frames(input: Error[]) { for await (const each of input) { return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'readonly-list',
    source:
      'function frames(input: readonly Error[]) { for (const each of input) { return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'aliased-list-type',
    source:
      'type Failures = Error[]; function frames(input: Failures) { for (const each of input) { return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-of-a-subclass',
    source:
      'function frames(input: TypeError[]) { for (const each of input) { return each.stack; } return ""; }',
    invocation: `frames([new TypeError("ours")])`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-of-a-union',
    source:
      'function frames(input: (Error | string)[]) { for (const each of input) { if (typeof each !== "string") return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'tuple-with-an-error',
    source:
      'function frames(input: [string, Error]) { for (const each of input) { if (typeof each !== "string") return each.stack; } return ""; }',
    invocation: 'frames(["a", new Error("ours")])',
    reader: true,
    refused: true,
  },
  {
    id: 'list-in-a-destructured-parameter',
    source:
      'function frames({ list }: { list: Error[] }) { for (const each of list) { return each.stack; } return ""; }',
    invocation: `frames({ list: ${LIST} })`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-in-a-member-of-a-parameter',
    source:
      'function frames(options: { list: Error[] }) { for (const each of options.list) { return each.stack; } return ""; }',
    invocation: `frames({ list: ${LIST} })`,
    reader: true,
    refused: true,
  },
  {
    id: 'rest-parameter',
    source:
      'function frames(...input: Error[]) { for (const each of input) { return each.stack; } return ""; }',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'defaulted-parameter',
    source:
      'function frames(input: Error[] = []) { for (const each of input) { return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'method-parameter',
    source:
      'class Holder { frames(input: Error[]) { for (const each of input) { return each.stack; } return ""; } }',
    invocation: `new Holder().frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'arrow-parameter',
    source:
      'const frames = (input: Error[]) => { for (const each of input) { return each.stack; } return ""; };',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'whole-const-alias-of-a-parameter',
    source:
      'function frames(input: Error[]) { const copy = input; for (const each of copy) { return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'object-pattern-variable',
    source:
      'function frames(input: { error: Error }[]) { for (const { error } of input) { return error.stack; } return ""; }',
    invocation: `frames([{ error: new Error("ours") }])`,
    reader: true,
    refused: true,
  },
  {
    id: 'array-pattern-variable',
    source:
      'function frames(input: Error[][]) { for (const [first] of input) { return first!.stack; } return ""; }',
    invocation: `frames([${LIST}])`,
    reader: true,
    refused: true,
  },
  {
    id: 'member-of-the-variable',
    source:
      'function frames(input: { error: Error }[]) { for (const box of input) { return box.error.stack; } return ""; }',
    invocation: `frames([{ error: new Error("ours") }])`,
    reader: true,
    refused: true,
  },
  {
    id: 'written-literal-of-a-parameter',
    source:
      'function frames(error: Error) { for (const each of [error]) { return each.stack; } return ""; }',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'written-literal-made-here-frames',
    source:
      'function frames() { for (const each of [new Error("ours")]) { return each.stack; } return ""; }',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'written-literal-made-here-words-pin',
    source:
      'function frames() { for (const each of [new Error("ours")]) { return each.message; } return ""; }',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
  {
    id: 'text-list-pin',
    source:
      'function frames(input: string[]) { for (const each of input) { return each.length; } return 0; }',
    invocation: 'frames(["a"])',
    reader: false,
    refused: false,
  },
  {
    id: 'data-list-pin',
    source:
      'function frames(input: { stack: string }[]) { for (const each of input) { return each.stack; } return ""; }',
    invocation: 'frames([{ stack: "fixed" }])',
    reader: false,
    refused: false,
  },
  {
    id: 'written-data-literal-pin',
    source:
      'function frames() { for (const each of [{ stack: "fixed" }]) { return each.stack; } return ""; }',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
  {
    id: 'unknown-list-pin',
    source:
      'function frames(input: unknown[]) { for (const each of input) { return typeof each; } return ""; }',
    invocation: 'frames(["a"])',
    reader: false,
    refused: false,
  },
  {
    id: 'member-that-is-no-frame-pin',
    source:
      'function frames(input: Error[]) { for (const each of input) { return each.name; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: false,
    refused: false,
  },
  {
    id: 'loop-that-reads-no-frame-pin',
    source:
      'function frames(input: Error[]) { let count = 0; for (const each of input) { void each; count += 1; } return count; }',
    invocation: `frames(${LIST})`,
    reader: false,
    refused: false,
  },
  {
    id: 'shadowed-variable-pin',
    source:
      'function frames(input: Error[]) { for (const each of input) { void each; { const each = { stack: "fixed" }; return each.stack; } } return ""; }',
    invocation: `frames(${LIST})`,
    reader: false,
    refused: false,
  },
  {
    id: 'key-of-a-for-in-pin',
    source:
      'function frames(input: Record<string, Error>) { for (const key in input) { return key.length; } return 0; }',
    invocation: 'frames({ a: new Error("ours") })',
    reader: false,
    refused: false,
  },
  {
    id: 'loop-variable-assigned-before-the-read',
    source:
      'function frames(input: { error: Error | { stack: string } }[]) { for (let box of input) { box = { error: { stack: "fixed" } }; return box.error.stack; } return ""; }',
    invocation: `frames([{ error: new Error("ours") }])`,
    reader: false,
    refused: false,
  },
  {
    id: 'loop-variable-read-whole-after-assignment-pin',
    source:
      'function frames(input: (Error | { stack: string })[]) { for (let each of input) { each = { stack: "fixed" }; return each.stack; } return ""; }',
    invocation: `frames([new Error("ours")])`,
    reader: true,
    refused: true,
  },
  {
    id: 'loop-variable-assigned-twice-before-the-read',
    source:
      'function frames(input: { error: Error | { stack: string } }[]) { for (let box of input) { box = { error: { stack: "first" } }; box = { error: { stack: "fixed" } }; return box.error.stack; } return ""; }',
    invocation: `frames([{ error: new Error("ours") }])`,
    reader: false,
    refused: false,
  },
  {
    id: 'loop-variable-assigned-conditionally-pin',
    source:
      'function frames(input: { error: Error | { stack: string } }[], flag: boolean) { for (let box of input) { if (flag) box = { error: { stack: "fixed" } }; return box.error.stack; } return ""; }',
    invocation: `frames([{ error: new Error("ours") }], true)`,
    reader: true,
    refused: true,
  },
  {
    id: 'loop-variable-assigned-after-the-read-pin',
    source:
      'function frames(input: { error: Error | { stack: string } }[]) { for (let box of input) { const stack = box.error.stack; box = { error: { stack: "fixed" } }; return stack; } return ""; }',
    invocation: `frames([{ error: new Error("ours") }])`,
    reader: true,
    refused: true,
  },
  {
    id: 'loop-variable-assigned-an-error-before-the-read-pin',
    source:
      'function frames(input: { error: Error | { stack: string } }[], error: Error) { for (let box of input) { box = { error }; return box.error.stack; } return ""; }',
    invocation: `frames([{ error: { stack: "fixed" } }], new Error("ours"))`,
    reader: true,
    refused: true,
  },
  {
    id: 'loop-variable-member-written-before-the-read-pin',
    source:
      'function frames(input: { error: Error | { stack: string } }[]) { for (const box of input) { box.error = { stack: "fixed" }; return box.error.stack; } return ""; }',
    invocation: `frames([{ error: new Error("ours") }])`,
    reader: true,
    refused: true,
  },
  {
    id: 'loop-variable-read-before-it-is-assigned-in-a-later-loop-pin',
    source:
      'function frames(input: { error: Error | { stack: string } }[]) { let last = ""; for (let box of input) { last = box.error.stack; box = { error: { stack: "fixed" } }; void box; } return last; }',
    invocation: `frames([{ error: new Error("ours") }])`,
    reader: true,
    refused: true,
  },
] as const;

describe('a variable a for…of header declares', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'loop-variable-origins.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('a shared module that reads a variable a for…of header declares', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await Promise.all(apps.map(async (app) => removed(app)));
  });

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compiledApp(app, api).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
