import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

/**
 * The first value of `values()`, `keys()`, `entries()` or the default iterator of a list, a Set or a
 * Map a parameter is declared as, read where no reader follows the collection (a parameter is what
 * its caller gives): the declared element, key or value, as `input[0]` reads the element of the same
 * list. A collection of text or data, the keys of a list, which are numbers, and the key of a Map of
 * text are no error.
 */
const LIST = '[new Error("ours")]';
const SET = 'new Set([new Error("ours")])';
const MAP = 'new Map([["key", new Error("ours")]])';

const CASES = [
  {
    id: 'list-values',
    source: 'function frames(input: Error[]) { return input.values().next().value!.stack; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-default-iterator',
    source:
      'function frames(input: Error[]) { return input[Symbol.iterator]().next().value!.stack; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-entries',
    source: 'function frames(input: Error[]) { return input.entries().next().value![1].stack; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-values-message',
    source: 'function frames(input: Error[]) { return input.values().next().value!.message; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-values-text-conversion',
    source: 'function frames(input: Error[]) { return String(input.values().next().value); }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-of-a-subclass',
    source: 'function frames(input: TypeError[]) { return input.values().next().value!.stack; }',
    invocation: `frames([new TypeError("ours")])`,
    reader: true,
    refused: true,
  },
  {
    id: 'readonly-list',
    source:
      'function frames(input: readonly Error[]) { return input.values().next().value!.stack; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-in-a-destructured-parameter',
    source:
      'function frames({ list }: { list: Error[] }) { return list.values().next().value!.stack; }',
    invocation: `frames({ list: ${LIST} })`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-in-a-member',
    source:
      'function frames(options: { list: Error[] }) { return options.list.values().next().value!.stack; }',
    invocation: `frames({ list: ${LIST} })`,
    reader: true,
    refused: true,
  },
  {
    id: 'rest-parameter',
    source: 'function frames(...input: Error[]) { return input.values().next().value!.stack; }',
    invocation: `frames(new Error("ours"))`,
    reader: true,
    refused: true,
  },
  {
    id: 'whole-const-alias-of-the-list',
    source:
      'function frames(input: Error[]) { const copy = input; return copy.values().next().value!.stack; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'whole-const-alias-of-the-iterator',
    source:
      'function frames(input: Error[]) { const cursor = input.values(); return cursor.next().value!.stack; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-method-parameter',
    source:
      'class Holder { frames(input: Error[]) { return input.values().next().value!.stack; } }',
    invocation: `new Holder().frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-arrow-parameter',
    source: 'const frames = (input: Error[]) => input[Symbol.iterator]().next().value!.stack;',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-values',
    source: 'function frames(input: Set<Error>) { return input.values().next().value!.stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-keys',
    source: 'function frames(input: Set<Error>) { return input.keys().next().value!.stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-default-iterator',
    source:
      'function frames(input: Set<Error>) { return input[Symbol.iterator]().next().value!.stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-entries-first-slot',
    source: 'function frames(input: Set<Error>) { return input.entries().next().value![0].stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-entries-second-slot',
    source: 'function frames(input: Set<Error>) { return input.entries().next().value![1].stack; }',
    invocation: `frames(${SET})`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-in-a-member',
    source:
      'function frames(options: { list: Set<Error> }) { return options.list.values().next().value!.stack; }',
    invocation: `frames({ list: ${SET} })`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-values',
    source:
      'function frames(input: Map<string, Error>) { return input.values().next().value!.stack; }',
    invocation: `frames(${MAP})`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-keys',
    source:
      'function frames(input: Map<Error, string>) { return input.keys().next().value!.stack; }',
    invocation: `frames(new Map([[new Error("ours"), "value"]]))`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-entries-value-slot',
    source:
      'function frames(input: Map<string, Error>) { return input.entries().next().value![1].stack; }',
    invocation: `frames(${MAP})`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-default-iterator-value-slot',
    source:
      'function frames(input: Map<string, Error>) { return input[Symbol.iterator]().next().value![1].stack; }',
    invocation: `frames(${MAP})`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-in-a-member',
    source:
      'function frames(options: { cache: Map<string, Error> }) { return options.cache.values().next().value!.stack; }',
    invocation: `frames({ cache: ${MAP} })`,
    reader: true,
    refused: true,
  },
  {
    id: 'set-built-from-a-parameter-pin',
    source:
      'function frames(input: Error[]) { return new Set(input)[Symbol.iterator]().next().value!.stack; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'text-list-pin',
    source: 'function frames(input: string[]) { return input.values().next().value!.length; }',
    invocation: `frames(["a"])`,
    reader: false,
    refused: false,
  },
  {
    id: 'data-list-pin',
    source:
      'function frames(input: { stack: string }[]) { return input.values().next().value!.stack; }',
    invocation: `frames([{ stack: "fixed" }])`,
    reader: false,
    refused: false,
  },
  {
    id: 'unknown-list-pin',
    source: 'function frames(input: unknown[]) { return typeof input.values().next().value; }',
    invocation: `frames(["a"])`,
    reader: false,
    refused: false,
  },
  {
    id: 'list-keys-are-numbers-pin',
    source: 'function frames(input: Error[]) { return String(input.keys().next().value); }',
    invocation: `frames(${LIST})`,
    reader: false,
    refused: false,
  },
  {
    id: 'list-entries-index-slot-pin',
    source: 'function frames(input: Error[]) { return String(input.entries().next().value![0]); }',
    invocation: `frames(${LIST})`,
    reader: false,
    refused: false,
  },
  {
    id: 'list-member-that-is-no-frame-pin',
    source: 'function frames(input: Error[]) { return input.values().next().value!.name; }',
    invocation: `frames(${LIST})`,
    reader: false,
    refused: false,
  },
  {
    id: 'text-set-pin',
    source: 'function frames(input: Set<string>) { return input.values().next().value!.length; }',
    invocation: `frames(new Set(["a"]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'data-set-pin',
    source:
      'function frames(input: Set<{ stack: string }>) { return input.values().next().value!.stack; }',
    invocation: `frames(new Set([{ stack: "fixed" }]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-key-text-pin',
    source:
      'function frames(input: Map<string, Error>) { return input.keys().next().value!.length; }',
    invocation: `frames(${MAP})`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-value-data-pin',
    source:
      'function frames(input: Map<Error, { stack: string }>) { return input.values().next().value!.stack; }',
    invocation: `frames(new Map([[new Error("ours"), { stack: "fixed" }]]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-entries-key-slot-text-pin',
    source:
      'function frames(input: Map<string, Error>) { return input.entries().next().value![0].length; }',
    invocation: `frames(${MAP})`,
    reader: false,
    refused: false,
  },
  {
    id: 'text-iterable-pin',
    source:
      'function frames(input: Iterable<string>) { return input[Symbol.iterator]().next().value!.length; }',
    invocation: `frames(["a"])`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-values-member-of-data-value',
    source:
      'function frames(input: Map<Error, [{ stack: string }]>) { return input.values().next().value![0].stack; }',
    invocation: `frames(new Map([[new Error("ours"), [{ stack: "fixed" }]]]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-values-member-of-data-value-second',
    source:
      'function frames(input: Map<string, [string, { stack: string }]>) { return input.values().next().value![1].stack; }',
    invocation: `frames(new Map([["key", ["a", { stack: "fixed" }]]]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-keys-member-of-data-key',
    source:
      'function frames(input: Map<[string, { stack: string }], Error>) { return input.keys().next().value![1].stack; }',
    invocation: `frames(new Map([[["a", { stack: "fixed" }], new Error("ours")]]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-entries-member-of-data-key',
    source:
      'function frames(input: Map<[string, { stack: string }], Error>) { return input.entries().next().value![0][1].stack; }',
    invocation: `frames(new Map([[["a", { stack: "fixed" }], new Error("ours")]]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-entries-member-of-data-value',
    source:
      'function frames(input: Map<Error, [{ stack: string }]>) { return input.entries().next().value![1][0].stack; }',
    invocation: `frames(new Map([[new Error("ours"), [{ stack: "fixed" }]]]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-member-of-data-key-pin',
    source:
      'function frames(input: Map<[string, { stack: string }], Error>) { return input[Symbol.iterator]().next().value![0][1].stack; }',
    invocation: `frames(new Map([[["a", { stack: "fixed" }], new Error("ours")]]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'set-values-member-of-data-element-pin',
    source:
      'function frames(input: Set<[{ stack: string }]>) { return input.values().next().value![0].stack; }',
    invocation: `frames(new Set([[{ stack: "fixed" }]]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'set-entries-member-of-data-element-pin',
    source:
      'function frames(input: Set<[{ stack: string }]>) { return input.entries().next().value![0][0].stack; }',
    invocation: `frames(new Set([[{ stack: "fixed" }]]))`,
    reader: false,
    refused: false,
  },
  {
    id: 'iterable-default-member-of-data-element-pin',
    source:
      'function frames(input: Iterable<[{ stack: string }]>) { return input[Symbol.iterator]().next().value![0].stack; }',
    invocation: `frames([[{ stack: "fixed" }]])`,
    reader: false,
    refused: false,
  },
  {
    id: 'list-values-member-of-data-element-pin',
    source:
      'function frames(input: [{ stack: string }][]) { return input.values().next().value![0].stack; }',
    invocation: `frames([[{ stack: "fixed" }]])`,
    reader: false,
    refused: false,
  },
  {
    id: 'list-entries-member-of-data-element-pin',
    source:
      'function frames(input: [{ stack: string }][]) { return input.entries().next().value![1][0].stack; }',
    invocation: `frames([[{ stack: "fixed" }]])`,
    reader: false,
    refused: false,
  },
  {
    id: 'map-values-of-error-values-beside-data-keys-pin',
    source:
      'function frames(input: Map<{ stack: string }, Error>) { return input.values().next().value!.stack; }',
    invocation: `frames(new Map([[{ stack: "fixed" }, new Error("ours")]]))`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-keys-of-error-keys-beside-data-values-pin',
    source:
      'function frames(input: Map<Error, { stack: string }>) { return input.keys().next().value!.stack; }',
    invocation: `frames(new Map([[new Error("ours"), { stack: "fixed" }]]))`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-entries-key-slot-of-error-keys-pin',
    source:
      'function frames(input: Map<Error, string>) { return input.entries().next().value![0].stack; }',
    invocation: `frames(new Map([[new Error("ours"), "value"]]))`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-entries-value-slot-beside-data-keys-pin',
    source:
      'function frames(input: Map<{ stack: string }, Error>) { return input.entries().next().value![1].stack; }',
    invocation: `frames(new Map([[{ stack: "fixed" }, new Error("ours")]]))`,
    reader: true,
    refused: true,
  },
  {
    id: 'map-default-key-slot-of-error-keys-pin',
    source:
      'function frames(input: Map<Error, string>) { return input[Symbol.iterator]().next().value![0].stack; }',
    invocation: `frames(new Map([[new Error("ours"), "value"]]))`,
    reader: true,
    refused: true,
  },
  {
    id: 'iterable-default-of-errors-pin',
    source:
      'function frames(input: Iterable<Error>) { return input[Symbol.iterator]().next().value!.stack; }',
    invocation: `frames([new Error("ours")])`,
    reader: true,
    refused: true,
  },
  {
    id: 'list-entries-element-pin',
    source: 'function frames(input: Error[]) { return input.entries().next().value![1].stack; }',
    invocation: `frames(${LIST})`,
    reader: true,
    refused: true,
  },
  {
    id: 'annotated-written-list-values',
    source:
      'function frames() { const input: Error[] = [new Error("ours")]; return input.values().next().value!.message; }',
    invocation: `frames()`,
    reader: false,
    refused: false,
  },
  {
    id: 'annotated-written-list-values-stack',
    source:
      'function frames() { const input: Error[] = [new Error("ours")]; return input.values().next().value!.stack; }',
    invocation: `frames()`,
    reader: false,
    refused: false,
  },
  {
    id: 'annotated-written-list-default-iterator',
    source:
      'function frames() { const input: Error[] = [new Error("ours")]; return input[Symbol.iterator]().next().value!.message; }',
    invocation: `frames()`,
    reader: false,
    refused: false,
  },
  {
    id: 'annotated-written-list-entries',
    source:
      'function frames() { const input: Error[] = [new Error("ours")]; return input.entries().next().value![1].message; }',
    invocation: `frames()`,
    reader: false,
    refused: false,
  },
  {
    id: 'annotated-written-set-values',
    source:
      'function frames() { const input: Set<Error> = new Set([new Error("ours")]); return input.values().next().value!.message; }',
    invocation: `frames()`,
    reader: false,
    refused: false,
  },
  {
    id: 'annotated-written-set-default-iterator',
    source:
      'function frames() { const input: Set<Error> = new Set([new Error("ours")]); return input[Symbol.iterator]().next().value!.message; }',
    invocation: `frames()`,
    reader: false,
    refused: false,
  },
  {
    id: 'annotated-added-set-pin',
    source:
      'function frames() { const input: Set<Error> = new Set<Error>().add(new Error("ours")); return input.values().next().value!.message; }',
    invocation: `frames()`,
    reader: true,
    refused: true,
  },
  {
    id: 'annotated-written-map-values',
    source:
      'function frames() { const input: Map<string, Error> = new Map([["key", new Error("ours")]]); return input.values().next().value!.message; }',
    invocation: `frames()`,
    reader: false,
    refused: false,
  },
  {
    id: 'annotated-written-map-entries',
    source:
      'function frames() { const input: Map<string, Error> = new Map([["key", new Error("ours")]]); return input.entries().next().value![1].message; }',
    invocation: `frames()`,
    reader: false,
    refused: false,
  },
  {
    id: 'annotated-list-of-a-call-pin',
    source:
      'function errors(): Error[] { return []; } function frames() { const input: Error[] = errors(); return input.values().next().value!.message; }',
    invocation: `frames()`,
    reader: true,
    refused: true,
  },
  {
    id: 'annotated-set-of-a-call-pin',
    source:
      'function errors(): Error[] { return []; } function frames() { const input: Set<Error> = new Set(errors()); return input.values().next().value!.message; }',
    invocation: `frames()`,
    reader: true,
    refused: true,
  },
  {
    id: 'annotated-let-written-list-pin',
    source:
      'function frames() { let input: Error[] = [new Error("ours")]; return input.values().next().value!.message; }',
    invocation: `frames()`,
    reader: true,
    refused: true,
  },
  {
    id: 'annotated-list-written-from-a-parameter-pin',
    source:
      'function frames(error: Error) { const input: Error[] = [error]; return input.values().next().value!.message; }',
    invocation: `frames(new Error("ours"))`,
    reader: true,
    refused: true,
  },
  {
    id: 'annotated-written-list-given-away-pin',
    source:
      'function keep(list: Error[]) { list.push(new Error("other")); } function frames() { const input: Error[] = [new Error("ours")]; keep(input); return input.values().next().value!.message; }',
    invocation: `frames()`,
    reader: true,
    refused: true,
  },
  {
    id: 'annotated-empty-set-added-to-pin',
    source:
      'function frames(error: Error) { const input: Set<Error> = new Set(); input.add(error); return input.values().next().value!.message; }',
    invocation: `frames(new Error("ours"))`,
    reader: true,
    refused: true,
  },
] as const;

describe('the value a native iterator of a declared collection yields', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'typed-iterator-results.ts', source);
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

describe('a shared module that reads the value a native iterator of a declared collection yields', () => {
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
