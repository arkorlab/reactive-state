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
  {
    id: 'rest-target',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ([...entry[1]] = [error])); }`,
    key: 'message',
    values: ["'safe':", '[error]:'],
  },
  {
    id: 'object-rest-target',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ({ ...entry[1] } = { field: error })); }`,
    key: 'message',
    values: ["'safe':", '{ field: error }:'],
  },
  {
    id: 'nested-rest-target',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ([[...entry[1]]] = [[error]])); }`,
    key: 'message',
    values: ["'safe':", '[error]:'],
  },
  {
    id: 'computed-key-rest-target',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: [...entry[1]] } = { field: [error] })); }`,
    key: 'message',
    values: ["'safe':", '[error]:'],
  },
  {
    id: 'rest-pattern-elements-pin',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ([...[entry[1]]] = [error])); }`,
    key: 'message',
    values: ["'safe':", '[error]:', 'error:'],
  },
  {
    id: 'pattern-default-not-evaluated',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ([{ x: entry[1] } = { x: error }] = [{ x: 'kept' }])); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'pattern-default-evaluated-pin',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ([{ x: entry[1] } = { x: error }] = [])); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'pattern-default-computed-key-pin',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: [entry[1]] = [error] } = { field: [] })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-nested-pattern',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: { x: entry[1] } } = { field: { x: error } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-nested-array',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: [entry[1]] } = { field: [error] })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'two-computed-keys',
    source: `function frames(error: Error, a: string, b: string) { ${ENTRY} return Object.fromEntries([entry], ({ [a]: { [b]: { x: entry[1] } } } = { f: { g: { x: error } } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-nested-other-field-pin',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: { y: entry[1] } } = { field: { x: error } })); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'empty-loop-head',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] of []); })()); }`,
    key: 'message',
    values: [],
  },
  {
    id: 'empty-spread-loop-head',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] of [...[]]); })()); }`,
    key: 'message',
    values: [],
  },
  {
    id: 'empty-string-loop-head',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] of ''); })()); }`,
    key: 'message',
    values: [],
  },
  {
    id: 'hole-loop-head-pin',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] of [,]); })()); }`,
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'opaque-loop-head-pin',
    source: `function frames(error: Error, list: string[]) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] of list); })()); }`,
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'listed-loop-head-pin',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] of ['message']); })()); }`,
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'computed-key-spread-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...{ field: error } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-nested-spread-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...{ ...{ field: error } }, other: 'kept' })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", 'error:'],
  },
  {
    id: 'computed-key-spread-array-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...[error] })); }`,
    key: 'message',
    values: ["'safe':", '[error]:', 'error:'],
  },
  {
    id: 'computed-key-spread-opaque-pin',
    source: `function frames(error: Error, name: string, record: Record<string, unknown>) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...record })); }`,
    key: 'message',
    values: ["'safe':", 'record:', 'record:0'],
  },
  {
    id: 'computed-key-overwritten-by-spread',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error, ...{ field: 'kept' } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'computed-key-overwritten-by-field',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error, ...{ other: 1 }, other: 2, field: 'kept' })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", '2:'],
  },
  {
    id: 'computed-key-overwritten-in-spread',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...{ field: error }, field: 'kept' })); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'computed-key-nested-spread-overwrite',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error, ...{ ...{ field: 'kept' } } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'computed-key-overwritten-by-opaque-pin',
    source: `function frames(error: Error, name: string, record: Record<string, unknown>) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error, ...record })); }`,
    key: 'message',
    values: ["'safe':", 'error:', 'record:', 'record:0'],
  },
  {
    id: 'computed-key-overwritten-by-computed-pin',
    source: `function frames(error: Error, name: string, other: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error, [other]: 'kept' })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", 'error:'],
  },
  {
    id: 'computed-key-other-field-kept-pin',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error, ...{ other: 'kept' } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", 'error:'],
  },
  {
    id: 'loop-head-default-not-evaluated',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], (() => { for ([{ x: entry[1] } = { x: error }] of [[{ x: 'kept' }]]); })()); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'loop-head-default-evaluated-pin',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], (() => { for ([{ x: entry[1] } = { x: error }] of [[]]); })()); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'loop-in-head-default-pin',
    source: `function frames(error: Error, record: Record<string, unknown>) { ${ENTRY} return Object.fromEntries([entry], (() => { for ([{ x: entry[1] } = { x: error }] in record); })()); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-prototype-sets-no-field',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ['__proto__']: error, ...{ __proto__: {} } })); }`,
    key: 'message',
    values: ["'safe':", '{}:', 'error:'],
  },
  {
    id: 'computed-key-computed-prototype-overwrites',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ['__proto__']: error, ...{ ['__proto__']: 'kept' } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'member-default-not-evaluated',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ([entry[1] = error] = ['kept'])); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'object-member-default-not-evaluated',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ({ x: entry[1] = error } = { x: 'kept' })); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'loop-head-member-default-not-evaluated',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], (() => { for ([entry[1] = error] of [['kept']]); })()); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'computed-key-getter-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { get field(): Error { return error; } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-spread-getter-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...{ get field(): Error { return error; } } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-getter-overwritten',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { get field(): Error { return error; }, field: 'kept' })); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'computed-key-setter-source-pin',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { set field(value: Error) { error; } })); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'computed-key-getter-then-setter',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { get field(): Error { return error; }, set field(value: Error) {} })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-setter-then-getter',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { set field(value: Error) {}, get field(): Error { return error; } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-spread-getter-setter',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...{ get field(): Error { return error; }, set field(value: Error) {} } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-data-then-setter-pin',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error, set field(value: Error) {} })); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'computed-key-getter-then-spread-pin',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { get field(): Error { return error; }, ...{ field: 'kept' } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'computed-key-spread-getter-then-setter-overwrite',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...{ get field(): Error { return error; } }, set field(value: Error) {} })); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'computed-key-spread-getter-then-getter-overwrite',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...{ get field(): Error { return error; } }, get field(): string { return 'kept'; } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'nested-computed-key-through-spread',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ outer: { [name]: entry[1] } } = { ...{ outer: { field: error } } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'nested-computed-key-through-spread-overwritten',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ outer: { [name]: entry[1] } } = { ...{ outer: { field: error } }, outer: { field: 'kept' } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'nested-computed-key-through-spread-first',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ outer: { [name]: entry[1] } } = { outer: { field: error }, ...{ other: 1 } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'nested-computed-key-through-opaque-spread-pin',
    source: `function frames(error: Error, name: string, record: Record<string, unknown>) { ${ENTRY} return Object.fromEntries([entry], ({ outer: { [name]: entry[1] } } = { ...record })); }`,
    key: 'message',
    values: ["'safe':", '{ ...record }:outer'],
  },
  {
    id: 'named-key-through-spread',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ({ outer: entry[1] } = { ...{ outer: error } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
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
