import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

/**
 * What a Set, a Map or an Iterable a parameter is declared as yields when it is iterated, where the
 * iteration is a place the code reads by position (a `for…of` variable, an array pattern): the
 * elements of a Set, the entries `[key, value]` of a Map, and so an error where the declared
 * argument is one, as the element of an `Error[]` is. A collection held in a member of a parameter
 * and one named through an alias are read the same; a collection of text or data, and the slot of an
 * entry that holds neither, are not.
 */
const SET = 'new Set([new Error("ours")])';
const MAP = 'new Map([["key", new Error("ours")]])';

const CASES = [
  {
    id: 'set-for-of',
    source:
      'function frames(input: Set<Error>) { for (const each of input) { return each.stack; } return ""; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-for-of-message',
    source:
      'function frames(input: Set<Error>) { let text = ""; for (const each of input) { text += each.message; } return text; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-for-of-text-conversion',
    source:
      'function frames(input: Set<Error>) { let text = ""; for (const each of input) { text += String(each); } return text; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'readonly-set-for-of',
    source:
      'function frames(input: ReadonlySet<Error>) { for (const each of input) { return each.stack; } return ""; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'aliased-set-type',
    source:
      'type Failures = Set<Error>; function frames(input: Failures) { for (const each of input) { return each.stack; } return ""; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-of-subclasses',
    source:
      'function frames(input: Set<TypeError>) { for (const each of input) { return each.stack; } return ""; }',
    invocation: `frames(new Set([new TypeError("ours")]))`,
    reader: true,
    refused: true,
  },
  {
    id: 'iterable-for-of',
    source:
      'function frames(input: Iterable<Error>) { for (const each of input) { return each.stack; } return ""; }',
    invocation: `frames([new Error("ours")])`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-in-a-member',
    source:
      'function frames(options: { list: Set<Error> }) { for (const each of options.list) { return each.stack; } return ""; }',
    invocation: `frames({ list: ${SET} })`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-in-a-destructured-parameter',
    source:
      'function frames({ list }: { list: Set<Error> }) { for (const each of list) { return each.stack; } return ""; }',
    invocation: `frames({ list: ${SET} })`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-in-an-optional-member',
    source:
      'function frames(options: { list?: Set<Error> }) { for (const each of options.list!) { return each.stack; } return ""; }',
    invocation: `frames({ list: ${SET} })`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-through-a-whole-const-alias',
    source:
      'function frames(input: Set<Error>) { const copy = input; for (const each of copy) { return each.stack; } return ""; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-method-parameter',
    source:
      'class Holder { frames(input: Set<Error>) { for (const each of input) { return each.stack; } return ""; } }',
    invocation: `new Holder().frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-arrow-parameter',
    source:
      'const frames = (input: Set<Error>) => { for (const each of input) { return each.stack; } return ""; };',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-assigned-loop-variable',
    source:
      'function frames(input: Set<Error>) { let each; for (each of input) { return each.stack; } return ""; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-array-pattern',
    source: 'function frames(input: Set<Error>) { const [first] = input; return first!.stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-array-pattern-assignment',
    source:
      'function frames(input: Set<Error>) { let first; [first] = input; return first!.stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-for-of-value',
    source:
      'function frames(input: Map<string, Error>) { for (const [, each] of input) { return each.stack; } return ""; }',
    invocation: `frames(${MAP})`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-for-of-key',
    source:
      'function frames(input: Map<Error, string>) { for (const [each] of input) { return each.stack; } return ""; }',
    invocation: `frames(new Map([[new Error("ours"), "value"]]))`,
    reader: true,
    refused: true,
  },
  {
    id: 'readonly-map-for-of-value',
    source:
      'function frames(input: ReadonlyMap<string, Error>) { for (const [, each] of input) { return each.stack; } return ""; }',
    invocation: `frames(${MAP})`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-in-a-member',
    source:
      'function frames(options: { cache: Map<string, Error> }) { for (const [, each] of options.cache) { return each.stack; } return ""; }',
    invocation: `frames({ cache: ${MAP} })`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-array-pattern',
    source:
      'function frames(input: Map<string, Error>) { const [[, value]] = input; return value!.stack; }',
    invocation: `frames(${MAP})`,
    reader: true,
    refused: true,
  },
  {
    id: 'text-set-pin',
    source:
      'function frames(input: Set<string>) { for (const each of input) { return each.length; } return 0; }',
    invocation: `frames(new Set(["a"]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'data-set-pin',
    source:
      'function frames(input: Set<{ stack: string }>) { for (const each of input) { return each.stack; } return ""; }',
    invocation: `frames(new Set([{ stack: "fixed" }]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'unknown-set-pin',
    source:
      'function frames(input: Set<unknown>) { for (const each of input) { return typeof each; } return ""; }',
    invocation: `frames(new Set(["a"]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'set-loop-reading-no-frame-pin',
    source:
      'function frames(input: Set<Error>) { let count = 0; for (const each of input) { void each; count += 1; } return count; }',
    invocation: `frames(${SET})`,
    reader: false,
    refused: false,
  },
  {
    id: 'set-member-that-is-no-frame-pin',
    source:
      'function frames(input: Set<Error>) { for (const each of input) { return each.name; } return ""; }',
    invocation: `frames(${SET})`,
    reader: false,
    refused: false,
  },
  {
    id: 'text-iterable-pin',
    source:
      'function frames(input: Iterable<string>) { for (const each of input) { return each.length; } return 0; }',
    invocation: `frames(["a"])`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-key-text-pin',
    source:
      'function frames(input: Map<string, Error>) { for (const [key] of input) { return key.length; } return 0; }',
    invocation: `frames(${MAP})`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-value-data-pin',
    source:
      'function frames(input: Map<Error, { stack: string }>) { for (const [, value] of input) { return value.stack; } return ""; }',
    invocation: `frames(new Map([[new Error("ours"), { stack: "fixed" }]]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-of-text-pin',
    source:
      'function frames(input: Map<string, string>) { for (const [, value] of input) { return value.length; } return 0; }',
    invocation: `frames(new Map([["a", "b"]]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'whole-entry-pin',
    source:
      'function frames(input: Map<string, Error>) { for (const entry of input) { return entry.length; } return 0; }',
    invocation: `frames(${MAP})`,
    reader: false,
    refused: false,
  },
] as const;

describe('what a declared Set, Map or Iterable yields', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'iterated-collection-types.ts', source);
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

describe('a shared module that reads what a declared Set, Map or Iterable yields', () => {
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
