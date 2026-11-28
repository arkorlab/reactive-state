import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

/**
 * A `for…of` over `values()`, `keys()`, `entries()` or the default iterator of a list, a Set or a Map
 * a parameter is declared as takes what the iterator yields: the declared element, key or value, an
 * entry's slot by its number, as the first value of the same iterator is read (`next().value`). The
 * keys of a list, and the index slot of its entries, are numbers.
 */
const LIST = '[new Error("ours")]';
const SET = 'new Set([new Error("ours")])';
const MAP = 'new Map([["key", new Error("ours")]])';

const CASES = [
  {
    id: 'list-values',
    source:
      'function frames(input: Error[]) { for (const each of input.values()) { return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-default-iterator',
    source:
      'function frames(input: Error[]) { for (const each of input[Symbol.iterator]()) { return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-entries-value-slot',
    source:
      'function frames(input: Error[]) { for (const [, each] of input.entries()) { return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-values-message',
    source:
      'function frames(input: Error[]) { let text = ""; for (const each of input.values()) { text += each.message; } return text; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-in-a-member',
    source:
      'function frames(options: { list: Error[] }) { for (const each of options.list.values()) { return each.stack; } return ""; }',
    invocation: `frames({ list: ${LIST} })`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-through-a-whole-const-alias',
    source:
      'function frames(input: Error[]) { const copy = input; for (const each of copy.values()) { return each.stack; } return ""; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-values',
    source:
      'function frames(input: Set<Error>) { for (const each of input.values()) { return each.stack; } return ""; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-keys',
    source:
      'function frames(input: Set<Error>) { for (const each of input.keys()) { return each.stack; } return ""; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-entries-each-slot',
    source:
      'function frames(input: Set<Error>) { for (const [first] of input.entries()) { return first.stack; } return ""; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-values',
    source:
      'function frames(input: Map<string, Error>) { for (const each of input.values()) { return each.stack; } return ""; }',
    invocation: `frames(${MAP})`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-keys',
    source:
      'function frames(input: Map<Error, string>) { for (const each of input.keys()) { return each.stack; } return ""; }',
    invocation: `frames(new Map([[new Error("ours"), "value"]]))`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-entries-value-slot',
    source:
      'function frames(input: Map<string, Error>) { for (const [, each] of input.entries()) { return each.stack; } return ""; }',
    invocation: `frames(${MAP})`,
    reader: true,
    refused: true,
  },
  {
    id: 'text-list-pin',
    source:
      'function frames(input: string[]) { for (const each of input.values()) { return each.length; } return 0; }',
    invocation: `frames(["a"])`,
    reader: false,
    refused: false,
  },
  {
    id: 'data-list-pin',
    source:
      'function frames(input: { stack: string }[]) { for (const each of input.values()) { return each.stack; } return ""; }',
    invocation: `frames([{ stack: "fixed" }])`,
    reader: false,
    refused: false,
  },
  {
    id: 'list-keys-are-numbers-pin',
    source:
      'function frames(input: Error[]) { let text = ""; for (const each of input.keys()) { text += String(each); } return text; }',
    invocation: `frames(${LIST})`,
    reader: false,
    refused: false,
  },
  {
    id: 'list-entries-index-slot-pin',
    source:
      'function frames(input: Error[]) { let text = ""; for (const [index] of input.entries()) { text += String(index); } return text; }',
    invocation: `frames(${LIST})`,
    reader: false,
    refused: false,
  },
  {
    id: 'list-entries-whole-entry-pin',
    source:
      'function frames(input: Error[]) { for (const entry of input.entries()) { return entry.length; } return 0; }',
    invocation: `frames(${LIST})`,
    reader: false,
    refused: false,
  },
  {
    id: 'set-of-text-pin',
    source:
      'function frames(input: Set<string>) { for (const each of input.values()) { return each.length; } return 0; }',
    invocation: `frames(new Set(["a"]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-key-text-pin',
    source:
      'function frames(input: Map<string, Error>) { for (const each of input.keys()) { return each.length; } return 0; }',
    invocation: `frames(${MAP})`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-entries-key-slot-text-pin',
    source:
      'function frames(input: Map<string, Error>) { for (const [key] of input.entries()) { return key.length; } return 0; }',
    invocation: `frames(${MAP})`,
    reader: false,
    refused: false,
  },
  {
    id: 'loop-that-reads-no-frame-pin',
    source:
      'function frames(input: Error[]) { let count = 0; for (const each of input.values()) { void each; count += 1; } return count; }',
    invocation: `frames(${LIST})`,
    reader: false,
    refused: false,
  },
] as const;

describe('a for…of variable over a native iterator of a declared collection', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'loop-iterator-sources.ts', source);
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

describe('a shared module that reads a for…of variable over a native iterator of a declared collection', () => {
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
