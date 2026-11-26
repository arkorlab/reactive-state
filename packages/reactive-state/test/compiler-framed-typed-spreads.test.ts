import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

/**
 * A Set or an Iterable a parameter is declared as, spread into a list, makes a list of what it
 * yields: the element at an index (`[...input][0]`), `at`, `find`, `shift` and a callback's
 * parameter read it as the elements of a declared array are read, so an `Error` the declared
 * argument is. A Set of text or data, and a spread of a Map's `values()` the list of which is not
 * read here, are not.
 */
const SET = 'new Set([new Error("ours")])';
const MAP = 'new Map([["key", new Error("ours")]])';

const CASES = [
  {
    id: 'set-spread-index',
    source: 'function frames(input: Set<Error>) { return [...input][0]!.stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-spread-index-message',
    source: 'function frames(input: Set<Error>) { return [...input][0]!.message; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-spread-at',
    source: 'function frames(input: Set<Error>) { return [...input].at(0)!.stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-spread-find',
    source: 'function frames(input: Set<Error>) { return [...input].find((each) => each)!.stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-spread-shift',
    source: 'function frames(input: Set<Error>) { return [...input].shift()!.stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-spread-callback-parameter',
    source:
      'function frames(input: Set<Error>) { return [...input].map((each) => each.stack).join(); }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'readonly-set-spread-index',
    source: 'function frames(input: ReadonlySet<Error>) { return [...input][0]!.stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'iterable-spread-index',
    source: 'function frames(input: Iterable<Error>) { return [...input][0]!.stack; }',
    invocation: `frames([new Error("ours")])`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-in-a-member-spread-index',
    source:
      'function frames(options: { list: Set<Error> }) { return [...options.list][0]!.stack; }',
    invocation: `frames({ list: ${SET} })`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-through-a-whole-const-alias',
    source:
      'function frames(input: Set<Error>) { const copy = input; return [...copy][0]!.stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-spread-after-other-elements',
    source: 'function frames(input: Set<Error>) { return [...input, ...input][1]!.stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-spread-value-slot-pin',
    source: 'function frames(input: Map<string, Error>) { return [...input][0]![1].stack; }',
    invocation: `frames(${MAP})`,
    reader: true,
    refused: true,
  },
  {
    id: 'text-set-spread-pin',
    source: 'function frames(input: Set<string>) { return [...input][0]!.length; }',
    invocation: `frames(new Set(["a"]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'data-set-spread-pin',
    source: 'function frames(input: Set<{ stack: string }>) { return [...input][0]!.stack; }',
    invocation: `frames(new Set([{ stack: "fixed" }]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'unknown-set-spread-pin',
    source: 'function frames(input: Set<unknown>) { return typeof [...input][0]; }',
    invocation: `frames(new Set(["a"]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'set-spread-member-that-is-no-frame-pin',
    source: 'function frames(input: Set<Error>) { return [...input][0]!.name; }',
    invocation: `frames(${SET})`,
    reader: false,
    refused: false,
  },
  {
    id: 'text-iterable-spread-pin',
    source: 'function frames(input: Iterable<string>) { return [...input][0]!.length; }',
    invocation: `frames(["a"])`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-key-text-spread-pin',
    source: 'function frames(input: Map<string, Error>) { return [...input][0]![0].length; }',
    invocation: `frames(${MAP})`,
    reader: false,
    refused: false,
  },
] as const;

describe('a spread of a declared Set or Iterable', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'typed-spreads.ts', source);
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

describe('a shared module that reads a spread of a declared Set or Iterable', () => {
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
