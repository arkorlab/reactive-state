import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `Object.fromEntries` reads each entry only after its whole argument list is evaluated: a native
 * object mutator that evaluation runs on an entry's tuple may give it a key or a value the
 * initializer did not write, and the tuple is read where its slots are asked, as one a mutator
 * wrote before the call is.
 */
const CASES = [
  {
    id: 'assign-in-an-argument',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, (Object.assign(entry, { 1: error }), ['other', 0])]); }",
    key: 'message',
    values: ["'safe':", 'error:', "Object.assign(entry, { 1: error }), ['other', 0]:1"],
  },
  {
    id: 'define-property-in-an-argument',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], Object.defineProperty(entry, 1, { value: error })); }",
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'define-properties-in-an-argument',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], Object.defineProperties(entry, { 1: { value: error } })); }",
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'assign-through-the-result-of-another',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], Object.assign(Object.assign(entry, {}), { 1: error })); }",
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'assign-a-getter-value',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], Object.assign(entry, { get 1() { return error; } })); }",
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'assign-the-key-slot',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['other', 'safe']; return Object.fromEntries([entry], Object.assign(entry, { 0: 'message' })); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'push-in-an-argument',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], entry.push(error)); }",
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'reverse-in-an-argument',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], entry.reverse()); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'splice-in-an-argument',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], entry.splice(0, 1, error)); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'call-given-the-tuple',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(row: [string, unknown]) { row[1] = error; } return Object.fromEntries([entry], reviewed(entry)); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'reflect-set-in-an-argument',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], Reflect.set(entry, 1, error)); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'constructor-given-the-tuple',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], new Set(entry)); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'assign-before-the-call-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; Object.assign(entry, { 1: error }); return Object.fromEntries([entry]); }",
    key: 'message',
    values: ['entry:1'],
  },
  {
    id: 'assign-to-another-tuple-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const other: [string, unknown] = ['x', 0]; return Object.fromEntries([entry], Object.assign(other, { 1: error })); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'assign-from-the-tuple-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const other: [string, unknown] = ['x', 0]; return Object.fromEntries([entry], Object.assign(other, entry)); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'call-without-the-tuple-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], Math.max(1, 2)); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'assign-in-a-function-never-called-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], () => Object.assign(entry, { 1: error })); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'assign-skipped-by-a-literal-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], false && Object.assign(entry, { 1: error })); }",
    key: 'message',
    values: ["'safe':"],
  },
] as const;

describe('entry tuples the argument list mutates by a native', () => {
  it.each(CASES)('$id', ({ source, key, values }) => {
    expect(selectedValues(source, key)).toStrictEqual(values);
  });
});

/** The values the source's `Object.fromEntries` call may install under the key, in text order. */
function selectedValues(source: string, key: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'entry-mutator-writes.ts', source);
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
