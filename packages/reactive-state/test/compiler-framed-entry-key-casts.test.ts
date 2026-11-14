import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Where `Object.fromEntries` converts a key to a name, an object there is converted by a hook
 * (`toString`, `valueOf`, `Symbol.toPrimitive`, or one its prototype has) that runs before the next
 * entry is read. A cast of any kind, `<T>x` as much as `x as T`, lies over the entry, the list or the
 * prototype that holds such an object: the compile reads through it, so a function the hook is,
 * which writes an entry's key, still counts as one that runs. The rows with a stored function show
 * what the cast must not refuse.
 */
const CASES = [
  {
    id: 'finding-tuple-cast',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <[unknown, number]>[{ toString: () => (entry[0] = 'other', 'unused') }, 0], entry] ); }",
    key: 'message',
    values: [
      "<[unknown, number]>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]:1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-entry',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0], entry] ); }",
    key: 'message',
    values: ["<any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]:1", 'entry:1', 'error:'],
  },
  {
    id: 'cast-entry-twice',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any><unknown>[{ toString: () => (entry[0] = 'other', 'unused') }, 0], entry] ); }",
    key: 'message',
    values: [
      "<any><unknown>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]:1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-entry-under-as',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0] as any, entry] ); }",
    key: 'message',
    values: ["<any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]:1", 'entry:1', 'error:'],
  },
  {
    id: 'as-entry-under-cast',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>([{ toString: () => (entry[0] = 'other', 'unused') }, 0] as any), entry] ); }",
    key: 'message',
    values: [
      "<any>([{ toString: () => (entry[0] = 'other', 'unused') }, 0] as any):1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-entry-in-parentheses',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], (<any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]), entry] ); }",
    key: 'message',
    values: ["<any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]:1", 'entry:1', 'error:'],
  },
  {
    id: 'cast-entry-non-null',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]!, entry] ); }",
    key: 'message',
    values: [
      "<any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]!:1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-entry-satisfies',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0] satisfies unknown, entry] ); }",
    key: 'message',
    values: ["<any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]:1", 'entry:1', 'error:'],
  },
  {
    id: 'cast-branch-of-a-condition',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], name ? <any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0] : ['x', 1], entry] ); }",
    key: 'message',
    values: [
      'entry:1',
      'error:',
      "name ? <any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0] : ['x', 1]:1",
    ],
  },
  {
    id: 'cast-of-a-condition',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>(name ? [{ toString: () => (entry[0] = 'other', 'unused') }, 0] : ['x', 1]), entry] ); }",
    key: 'message',
    values: [
      "<any>(name ? [{ toString: () => (entry[0] = 'other', 'unused') }, 0] : ['x', 1]):1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-last-of-a-comma',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], (0, <any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]), entry] ); }",
    key: 'message',
    values: [
      "0, <any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]:1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-of-a-logical-operand',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>(name && [{ toString: () => (entry[0] = 'other', 'unused') }, 0]), entry] ); }",
    key: 'message',
    values: [
      "<any>(name && [{ toString: () => (entry[0] = 'other', 'unused') }, 0]):1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-entry-with-a-function-expression-hook',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>[{ valueOf: function () { entry[0] = 'other'; return 'u'; } }, 0], entry] ); }",
    key: 'message',
    values: [
      "<any>[{ valueOf: function () { entry[0] = 'other'; return 'u'; } }, 0]:1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-entry-with-a-to-primitive-arrow',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>[{ [Symbol.toPrimitive]: () => (entry[0] = 'other', 'u') }, 0], entry] ); }",
    key: 'message',
    values: [
      "<any>[{ [Symbol.toPrimitive]: () => (entry[0] = 'other', 'u') }, 0]:1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-entry-with-an-inherited-hook',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>[{ __proto__: { toString: () => (entry[0] = 'other', 'u') } }, 0], entry] ); }",
    key: 'message',
    values: [
      "<any>[{ __proto__: { toString: () => (entry[0] = 'other', 'u') } }, 0]:1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-entry-object-field-0',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>{ 0: { toString: () => (entry[0] = 'other', 'unused') }, 1: 0 }, entry] ); }",
    key: 'message',
    values: [
      "<any>{ 0: { toString: () => (entry[0] = 'other', 'unused') }, 1: 0 }:1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-entry-object-with-a-cast-prototype',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>{ __proto__: <any>{ 0: { toString: () => (entry[0] = 'other', 'unused') } }, 1: 0 }, entry] ); }",
    key: 'message',
    values: [
      "<any>{ __proto__: <any>{ 0: { toString: () => (entry[0] = 'other', 'unused') } }, 1: 0 }:1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-prototype-with-a-hook',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], [{ __proto__: <any>{ toString: () => (entry[0] = 'other', 'u') } }, 0], entry] ); }",
    key: 'message',
    values: ['0:', 'entry:1', 'error:'],
  },
  {
    id: 'cast-spread-source-of-an-entry-object',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], { ...<any>{ 0: { toString: () => (entry[0] = 'other', 'unused') } } }, entry] ); }",
    key: 'message',
    values: [
      "{ ...<any>{ 0: { toString: () => (entry[0] = 'other', 'unused') } } }:1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-list-spread-into-the-iterable',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], ...<any>[<any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]], entry] ); }",
    key: 'message',
    values: [
      "<any>[<any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]]:0.1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-list-in-the-iterable-spread-twice',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], ...<any>[...<any>[<any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]]], entry] ); }",
    key: 'message',
    values: [
      "<any>[...<any>[<any>[{ toString: () => (entry[0] = 'other', 'unused') }, 0]]]:0.1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-hook-function',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>[{ toString: <any>(() => (entry[0] = 'other', 'u')) }, 0], entry] ); }",
    key: 'message',
    values: [
      "<any>[{ toString: <any>(() => (entry[0] = 'other', 'u')) }, 0]:1",
      'entry:1',
      'error:',
    ],
  },
  {
    id: 'cast-entry-without-a-hook-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>['other', 0], entry] ); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'cast-entry-with-a-plain-object-key-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>[{ plain: 1 }, 0], entry] ); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'cast-entry-with-a-function-key-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>[() => 1, 0], entry] ); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'hook-in-the-value-slot-of-a-cast-entry-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], <any>['other', { toString: () => (entry[1] = error, 'x') }], entry] ); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'hook-in-the-value-slot-of-an-entry-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], ['other', <any>{ toString: () => (entry[1] = error, 'x') }], entry] ); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'stored-arrow-in-a-cast-object-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(x: unknown) { entry[1] = error; } return Object.fromEntries([entry, ['unused', <any>{ run: () => reviewed(entry) }]] ); }",
    key: 'message',
    values: ['entry:1'],
  },
  {
    id: 'stored-arrow-under-a-cast-null-prototype-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(x: unknown) { entry[1] = error; } return Object.fromEntries([entry, ['unused', { __proto__: <any>null, run: () => reviewed(entry) }]] ); }",
    key: 'message',
    values: ['entry:1'],
  },
  {
    id: 'stored-arrow-under-a-cast-plain-prototype-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(x: unknown) { entry[1] = error; } return Object.fromEntries([entry, ['unused', { __proto__: <any>{ x: 1 }, run: () => reviewed(entry) }]] ); }",
    key: 'message',
    values: ['entry:1'],
  },
  {
    id: 'stored-arrow-under-a-cast-accessor-prototype',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(x: unknown) { entry[1] = error; } return Object.fromEntries([entry, ['unused', { __proto__: <any>{ get x() { return 1; } }, run: () => reviewed(entry) }]] ); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'stored-arrow-under-a-cast-array-prototype-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(x: unknown) { entry[1] = error; } return Object.fromEntries([entry, ['unused', { __proto__: <any>[1], run: () => reviewed(entry) }]] ); }",
    key: 'message',
    values: ['entry:1'],
  },
  {
    id: 'stored-arrow-under-a-cast-name-prototype',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(x: unknown) { entry[1] = error; } return Object.fromEntries([entry, ['unused', { __proto__: <any>key, run: () => reviewed(entry) }]] ); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'computed-proto-field-with-a-stored-arrow-refused-pin',
    source:
      "function frames(error: Error, proto: object) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(x: unknown) { entry[1] = error; } return Object.fromEntries([entry, ['unused', { ['__proto__']: proto, run: () => reviewed(entry) }]] ); }",
    key: 'message',
    values: undefined,
  },
] as const;

describe('entry keys read through casts', () => {
  it.each(CASES)('$id', ({ source, key, values }) => {
    expect(selectedValues(source, key)).toStrictEqual(values);
  });
});

/** The values the source's `Object.fromEntries` call may install under the key, in text order. */
function selectedValues(source: string, key: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'entry-key-casts.ts', source);
  return framedEntryValues(entriesCall(parsed.sourceFile), key)
    ?.map((each) => `${each.value.getText()}:${each.keys.join('.')}`)
    .toSorted((left, right) => left.localeCompare(right));
}

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
