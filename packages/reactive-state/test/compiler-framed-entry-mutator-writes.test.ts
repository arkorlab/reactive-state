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
  {
    id: 'closure-declared-after-the-call',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([entry, (reviewed(), ['other', 0])]); function reviewed() { entry[1] = error; } return out; }",
    key: 'message',
    values: ['entry:1', "reviewed(), ['other', 0]:1"],
  },
  {
    id: 'closure-called-by-a-callback',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, [1].map(() => { entry[1] = error; })]); }",
    key: 'message',
    values: ['[1].map(() => { entry[1] = error; }):1', 'entry:1'],
  },
  {
    id: 'closure-declared-before-the-call-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; function reviewed() { entry[1] = error; } return Object.fromEntries([entry, (reviewed(), ['other', 0])]); }",
    key: 'message',
    values: ['entry:1', "reviewed(), ['other', 0]:1"],
  },
  {
    id: 'closure-that-no-call-runs-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([entry, ['other', 0]]); function reviewed() { entry[1] = error; } return out; }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'tuple-given-through-a-condition',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(row: [string, unknown]) { row[1] = error; } return Object.fromEntries([entry], reviewed(true ? entry : [])); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'tuple-given-through-a-comma',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(row: [string, unknown]) { row[1] = error; } return Object.fromEntries([entry], reviewed((0, entry))); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'tuple-given-through-an-assignment',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; let held: unknown; function reviewed(row: unknown) { (row as [string, unknown])[1] = error; } return Object.fromEntries([entry], reviewed((held = entry))); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'tuple-given-in-a-list',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(rows: [string, unknown][]) { rows[0]![1] = error; } return Object.fromEntries([entry], reviewed([entry])); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'tuple-given-through-a-logical-operator',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(row: [string, unknown]) { row[1] = error; } return Object.fromEntries([entry], reviewed(entry || [])); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'tuple-given-in-a-spread-list',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; function reviewed(row: [string, unknown]) { row[1] = error; } return Object.fromEntries([entry], reviewed(...[entry])); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'tuple-held-in-a-constant-list',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const held = [entry]; function reviewed(row: [string, unknown]) { row[1] = error; } return Object.fromEntries([entry], reviewed(...held)); }",
    key: 'message',
    values: ['entry:1'],
  },
  {
    id: 'assign-through-the-result-of-an-aliased-assign',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const assign = Object.assign; return Object.fromEntries([entry], Object.assign(assign(entry, {}), { 1: error })); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'assign-through-a-condition',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], Object.assign(true ? entry : [], { 1: error })); }",
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'member-read-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['other', entry.length]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'tuple-element-read-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['other', entry[1]]]); }",
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
