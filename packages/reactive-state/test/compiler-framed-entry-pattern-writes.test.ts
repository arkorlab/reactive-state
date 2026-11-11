import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A destructuring assignment in `Object.fromEntries`'s arguments, or a loop head in a function they
 * call at once, writes the slots of an entry's tuple that its patterns name: the value it hands to
 * one is a possible value, and one handed to slot `0` leaves the key unknown.
 */
const ENTRY = "const entry: [string, unknown] = ['message', 'safe'];";

const CASES = [
  {
    id: 'reviewed-array-pattern',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ([entry[1]] = [error])); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'object-pattern',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ({ value: entry[1] } = { value: error })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'nested-pattern',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ([[entry[1]]] = [[error]])); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'key-slot-pattern',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], ([entry[0]] = ['message'])); }`,
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'loop-head',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], (() => { for (entry[1] of [error]); })()); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-pattern',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'dotted-field-names',
    source: `function frames(source: { a: { b: Error }; 'a.b': Error }) { ${ENTRY} return Object.fromEntries([entry], ({ 'a.b': entry[1], a: { b: entry[1] } } = source)); }`,
    key: 'message',
    values: ["'safe':", 'source:a.b', 'source:a/b'],
  },
  {
    id: 'computed-key-known-slot',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[0] } = { field: 'message', unused: error })); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'nested-computed-key',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ outer: { [name]: entry[1] } } = { outer: { field: error } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-target-index',
    source: `function frames(error: Error, name: string, holder: Record<string, unknown>) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: holder[entry[1] as string] } = { field: error })); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'computed-key-default-read',
    source: `function frames(error: Error, name: string) { ${ENTRY} let sink; return Object.fromEntries([entry], ({ [name]: sink = entry[0] } = { field: error })); }`,
    key: 'other',
    values: [],
  },
  {
    id: 'computed-key-default-write-pin',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] = 0 } = { field: error })); }`,
    key: 'message',
    values: ["'safe':", '0:', 'error:'],
  },
  {
    id: 'computed-key-other-tuple-pin',
    source: `function frames(error: Error, name: string) { ${ENTRY} const other: [string, unknown] = ['x', 0]; return Object.fromEntries([entry], ({ [name]: other[1] } = { field: error })); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'default-pattern-pin',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ([entry[1] = error] = [])); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'other-tuple-pin',
    source: `function frames(error: Error) { ${ENTRY} const other: [string, unknown] = ['x', 0]; return Object.fromEntries([entry], ([other[1]] = [error])); }`,
    key: 'message',
    values: ["'safe':"],
  },
] as const;

describe('entry tuple slots a destructuring write names', () => {
  it.each(CASES)('$id', ({ source, key, values }) => {
    expect(selectedValues(source, key)).toStrictEqual(values);
  });
});

/** The values the source's `Object.fromEntries` call may install under the key, in text order. */
function selectedValues(source: string, key: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'entry-pattern-writes.ts', source);
  return framedEntryValues(entriesCall(parsed.sourceFile), key)
    ?.map((each) => `${each.value.getText()}:${each.keys.join('/')}`)
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
