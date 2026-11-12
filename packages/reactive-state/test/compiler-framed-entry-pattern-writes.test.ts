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
    values: ["'safe':", 'error:'],
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
  {
    id: 'computed-key-prototype-field',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { __proto__: { field: error } })); }`,
    key: 'message',
    values: ["'safe':", '{ field: error }:', 'error:'],
  },
  {
    id: 'computed-key-prototype-chain',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { __proto__: { __proto__: { field: error } } })); }`,
    key: 'message',
    values: ["'safe':", '{ __proto__: { field: error } }:', '{ field: error }:', 'error:'],
  },
  {
    id: 'computed-key-own-field-over-prototype',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { __proto__: { field: error }, field: 'kept' })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", '{ field: error }:'],
  },
  {
    id: 'computed-key-spread-prototype-pin',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...{ __proto__: { field: error } } })); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'computed-key-constant-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} const source = { field: error }; return Object.fromEntries([entry], ({ [name]: entry[1] } = source)); }`,
    key: 'message',
    values: ["'safe':", 'error:', 'source:', 'source:0'],
  },
  {
    id: 'computed-key-conditional-source',
    source: `function frames(error: Error, name: string, flag: boolean) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = flag ? { field: error } : {})); }`,
    key: 'message',
    values: [
      "'safe':",
      'error:',
      'flag ? { field: error } : {}:',
      'flag ? { field: error } : {}:0',
    ],
  },
  {
    id: 'computed-key-constant-conditional-source',
    source: `function frames(error: Error, name: string, flag: boolean) { ${ENTRY} const source = flag ? { field: error } : {}; return Object.fromEntries([entry], ({ [name]: entry[1] } = source)); }`,
    key: 'message',
    values: [
      "'safe':",
      'error:',
      'flag ? { field: error } : {}:',
      'flag ? { field: error } : {}:0',
      'source:',
      'source:0',
    ],
  },
  {
    id: 'computed-key-literal-condition-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = true ? { field: 'kept' } : { field: error })); }`,
    key: 'message',
    values: [
      "'kept':",
      "'safe':",
      "true ? { field: 'kept' } : { field: error }:",
      "true ? { field: 'kept' } : { field: error }:0",
    ],
  },
  {
    id: 'computed-key-constant-spread-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} const base = { field: error }; const source = { ...base }; return Object.fromEntries([entry], ({ [name]: entry[1] } = source)); }`,
    key: 'message',
    values: ["'safe':", 'base:', 'base:0', 'error:', 'source:', 'source:0'],
  },
  {
    id: 'computed-key-self-referential-source-pin',
    source: `function frames(error: Error, name: string, flag: boolean) { ${ENTRY} const source: object = flag ? { field: error } : source; return Object.fromEntries([entry], ({ [name]: entry[1] } = source)); }`,
    key: 'message',
    values: [
      "'safe':",
      'error:',
      'flag ? { field: error } : source:',
      'flag ? { field: error } : source:0',
      'source:',
      'source:',
      'source:0',
      'source:0',
    ],
  },
  {
    id: 'computed-key-short-circuited-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = false && { field: error })); }`,
    key: 'message',
    values: [
      "'safe':",
      'false && { field: error }:',
      'false && { field: error }:0',
      'false:',
      'false:0',
    ],
  },
  {
    id: 'computed-key-nullish-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = null ?? { field: error })); }`,
    key: 'message',
    values: ["'safe':", 'error:', 'null ?? { field: error }:', 'null ?? { field: error }:0'],
  },
  {
    id: 'computed-key-truthy-or-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = true || { field: error })); }`,
    key: 'message',
    values: [
      "'safe':",
      'true || { field: error }:',
      'true || { field: error }:0',
      'true:',
      'true:0',
    ],
  },
  {
    id: 'named-prototype-key-through-spread',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ({ __proto__: entry[1] } = { ['__proto__']: error, ...{ __proto__: {} } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'named-computed-prototype-key-through-spread',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ({ ['__proto__']: entry[1] } = { ['__proto__']: error, ...{ __proto__: {} } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'named-prototype-key-direct-pin',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], ({ __proto__: entry[1] } = { __proto__: error })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'computed-key-self-referential-spread-pin',
    source: `function frames(error: Error, name: string, flag: boolean) { ${ENTRY} const source: object = { ...(flag ? source : { field: error }) }; return Object.fromEntries([entry], ({ [name]: entry[1] } = source)); }`,
    key: 'message',
    values: [
      "'safe':",
      '(flag ? source : { field: error }):',
      'error:',
      'flag ? source : { field: error }:0',
      'source:',
      'source:',
      'source:0',
      'source:0',
    ],
  },
  {
    id: 'computed-key-self-referential-prototype-pin',
    source: `function frames(error: Error, name: string, flag: boolean) { ${ENTRY} const source: object = { __proto__: flag ? source : { field: error } }; return Object.fromEntries([entry], ({ [name]: entry[1] } = source)); }`,
    key: 'message',
    values: [
      "'safe':",
      'error:',
      'flag ? source : { field: error }:',
      'flag ? source : { field: error }:0',
      'source:',
      'source:',
      'source:0',
      'source:0',
    ],
  },
  {
    id: 'computed-key-constant-spread-overwritten',
    source: `function frames(error: Error, name: string) { ${ENTRY} const base = { field: error }; return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...base, field: 'kept' })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", 'base:', 'base:0'],
  },
  {
    id: 'computed-key-constant-spread-prototype-pin',
    source: `function frames(error: Error, name: string) { ${ENTRY} const base = { __proto__: { field: error } }; return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...base })); }`,
    key: 'message',
    values: ["'safe':", 'base:', 'base:0'],
  },
  {
    id: 'computed-key-conditional-spread-overwritten',
    source: `function frames(error: Error, name: string, flag: boolean) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { ...(flag ? { field: error } : {}), field: 'kept' })); }`,
    key: 'message',
    values: [
      "'kept':",
      "'safe':",
      '(flag ? { field: error } : {}):',
      'flag ? { field: error } : {}:0',
    ],
  },
  {
    id: 'computed-key-shadowed-undefined-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} const undefined = { field: error }; return Object.fromEntries([entry], ({ [name]: entry[1] } = undefined ?? {})); }`,
    key: 'message',
    values: [
      "'safe':",
      'error:',
      'undefined ?? {}:',
      'undefined ?? {}:0',
      'undefined:',
      'undefined:0',
    ],
  },
  {
    id: 'computed-key-constant-null-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} const empty = null; return Object.fromEntries([entry], ({ [name]: entry[1] } = empty ?? { field: error })); }`,
    key: 'message',
    values: ["'safe':", 'empty ?? { field: error }:', 'empty ?? { field: error }:0', 'error:'],
  },
  {
    id: 'computed-key-alias-of-itself-pin',
    source: `function frames(error: Error, name: string) { ${ENTRY} const source: object = source; return Object.fromEntries([entry], ({ [name]: entry[1] } = source ?? {})); }`,
    key: 'message',
    values: [
      "'safe':",
      'source ?? {}:',
      'source ?? {}:0',
      'source:',
      'source:',
      'source:0',
      'source:0',
    ],
  },
  {
    id: 'computed-key-constant-spread-hides-field',
    source: `function frames(error: Error, name: string) { ${ENTRY} const base = { field: 'kept' }; return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error, ...base })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", 'base:', 'base:0'],
  },
  {
    id: 'computed-key-conditional-constant-spread-keeps-field',
    source: `function frames(error: Error, name: string, flag: boolean) { ${ENTRY} const base = flag ? { field: 'kept' } : {}; return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error, ...base })); }`,
    key: 'message',
    values: [
      "'kept':",
      "'safe':",
      'base:',
      'base:0',
      'error:',
      "flag ? { field: 'kept' } : {}:",
      "flag ? { field: 'kept' } : {}:0",
    ],
  },
  {
    id: 'computed-key-assignment-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} let source: object = {}; return Object.fromEntries([entry], ({ [name]: entry[1] } = (source = { field: error }))); }`,
    key: 'message',
    values: ["'safe':", '(source = { field: error }):', 'error:', 'source = { field: error }:0'],
  },
  {
    id: 'computed-key-comma-source',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = (0, { field: error }))); }`,
    key: 'message',
    values: ["'safe':", '(0, { field: error }):', '0, { field: error }:0', 'error:'],
  },
  {
    id: 'computed-key-changed-constant-spread-keeps-field',
    source: `function frames(error: Error, name: string) { ${ENTRY} const base: { field?: string } = { field: 'kept' }; delete base.field; return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error, ...base })); }`,
    key: 'message',
    values: ["'kept':", 'base:', 'base:0', 'entry:1', 'error:'],
  },
  {
    id: 'computed-key-escaped-constant-spread-keeps-field',
    source: `function frames(error: Error, name: string, change: (value: object) => void) { ${ENTRY} const base = { field: 'kept' }; change(base); return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error, ...base })); }`,
    key: 'message',
    values: ["'kept':", 'base:', 'base:0', 'entry:1', 'error:'],
  },
  {
    id: 'computed-key-own-prototype-field-shadows-prototype',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { __proto__: error, ['__proto__']: 'kept' })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", 'error:0'],
  },
  {
    id: 'computed-key-own-prototype-field-keeps-inherited-fields',
    source: `function frames(error: Error, name: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { __proto__: { field: error }, ['__proto__']: 'kept' })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", 'error:'],
  },
  {
    id: 'named-key-prototype-field',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ field: entry[1] } = { __proto__: { field: error } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'named-key-prototype-chain',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ field: entry[1] } = { __proto__: { __proto__: { field: error } } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'named-key-own-field-over-prototype-pin',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ field: entry[1] } = { __proto__: { field: error }, field: 'kept' })); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'named-key-prototype-other-field-pin',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ field: entry[1] } = { __proto__: { other: error } })); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'named-key-spread-prototype-pin',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ field: entry[1] } = { ...{ __proto__: { field: error } } })); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'named-key-null-prototype-pin',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ field: entry[1] } = { __proto__: null })); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'named-key-computed-prototype-name-keeps-inherited',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ field: entry[1] } = { __proto__: { field: error }, ['__proto__']: 'x' })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'named-key-nested-prototype-field',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ outer: { field: entry[1] } } = { outer: { __proto__: { field: error } } })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'named-key-prototype-array-element',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ 0: entry[1] } = { __proto__: [error] })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'named-key-prototype-constant-is-opaque',
    source: `function frames(error: Error)  { const entry: [string, unknown] = ['message', 'safe']; const base = { field: error }; return Object.fromEntries([entry], ({ field: entry[1] } = { __proto__: base })); }`,
    key: 'message',
    values: ["'safe':", '{ __proto__: base }:field'],
  },
  {
    id: 'named-key-prototype-call-is-opaque',
    source: `function frames(error: Error, make: () => object) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ field: entry[1] } = { __proto__: make() })); }`,
    key: 'message',
    values: ["'safe':", '{ __proto__: make() }:field'],
  },
  {
    id: 'named-key-own-prototype-name-is-no-prototype',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ field: entry[1] } = { ['__proto__']: { field: error } })); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'for-in-empty-object-head',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in {}); })()); }`,
    key: 'message',
    values: [],
  },
  {
    id: 'for-in-empty-list-head',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in []); })()); }`,
    key: 'message',
    values: [],
  },
  {
    id: 'for-in-list-of-holes-head',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in [, ,]); })()); }`,
    key: 'message',
    values: [],
  },
  {
    id: 'for-in-empty-string-head',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in ''); })()); }`,
    key: 'message',
    values: [],
  },
  {
    id: 'for-in-null-head',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in null); })()); }`,
    key: 'message',
    values: [],
  },
  {
    id: 'for-in-undefined-head',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in undefined); })()); }`,
    key: 'message',
    values: [],
  },
  {
    id: 'for-in-void-head',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in void 0); })()); }`,
    key: 'message',
    values: [],
  },
  {
    id: 'for-in-spread-of-nothing-head',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in { ...{}, ...null }); })()); }`,
    key: 'message',
    values: [],
  },
  {
    id: 'for-in-spread-of-empty-list-head',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in { ...[] }); })()); }`,
    key: 'message',
    values: [],
  },
  {
    id: 'for-in-object-field-head-pin',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in { a: 1 }); })()); }`,
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'for-in-object-getter-head-pin',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in { get a() { return 1; } }); })()); }`,
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'for-in-inherited-field-head-pin',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in { __proto__: { a: 1 } }); })()); }`,
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'for-in-non-empty-string-head-pin',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in 'ab'); })()); }`,
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'for-in-list-element-head-pin',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in [1]); })()); }`,
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'for-in-spread-of-field-head-pin',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in { ...{ a: 1 } }); })()); }`,
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'for-in-unknown-head-pin',
    source: `function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (() => { for (entry[0] in flag ? {} : { a: 1 }); })()); }`,
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'named-prototype-key-own-field-over-setter',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ __proto__: entry[1] } = { ['__proto__']: error, __proto__: {} })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'named-prototype-key-own-field-only',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ __proto__: entry[1] } = { ['__proto__']: error })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'named-prototype-key-no-setter-is-object-prototype',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ __proto__: entry[1] } = {})); }`,
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'named-prototype-key-setter-after-own-field-of-another-name',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ __proto__: entry[1] } = { field: error, __proto__: error })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'named-prototype-key-own-field-after-setter',
    source: `function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ({ __proto__: entry[1] } = { __proto__: {}, ['__proto__']: error })); }`,
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'rest-pattern-after-consumed-entry',
    source: `function frames(error: Error, list: unknown[]) { const entry: [string, unknown] = ['message', 'safe']; let sink: unknown; let other: unknown; return Object.fromEntries([entry], ([sink, ...[entry[1]]] = [error, 'kept'])); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'rest-pattern-after-two-consumed-entries',
    source: `function frames(error: Error, list: unknown[]) { const entry: [string, unknown] = ['message', 'safe']; let sink: unknown; let other: unknown; return Object.fromEntries([entry], ([sink, other, ...[entry[1]]] = [error, 'a', 'kept'])); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'rest-pattern-from-start-keeps-all',
    source: `function frames(error: Error, list: unknown[]) { const entry: [string, unknown] = ['message', 'safe']; let sink: unknown; let other: unknown; return Object.fromEntries([entry], ([...[entry[1]]] = [error, 'kept'])); }`,
    key: 'message',
    values: ["'kept':", "'safe':", "[error, 'kept']:", 'error:'],
  },
  {
    id: 'rest-pattern-after-unknown-spread-keeps-all',
    source: `function frames(error: Error, list: unknown[]) { const entry: [string, unknown] = ['message', 'safe']; let sink: unknown; let other: unknown; return Object.fromEntries([entry], ([sink, ...[entry[1]]] = [...list, error, 'kept'])); }`,
    key: 'message',
    values: ["'kept':", "'safe':", "[...list, error, 'kept']:", 'error:', 'list:0'],
  },
  {
    id: 'rest-member-after-consumed-entry',
    source: `function frames(error: Error, list: unknown[]) { const entry: [string, unknown] = ['message', 'safe']; let sink: unknown; let other: unknown; return Object.fromEntries([entry], ([sink, ...entry[1]] = [error, 'kept'])); }`,
    key: 'message',
    values: ["'safe':", "[error, 'kept']:"],
  },
  {
    id: 'rest-member-from-start-keeps-entries',
    source: `function frames(error: Error, list: unknown[]) { const entry: [string, unknown] = ['message', 'safe']; let sink: unknown; let other: unknown; return Object.fromEntries([entry], ([...entry[1]] = [error, 'kept'])); }`,
    key: 'message',
    values: ["'safe':", "[error, 'kept']:"],
  },
  {
    id: 'rest-pattern-computed-key-after-consumed-entry',
    source: `function frames(error: Error, list: unknown[]) { const entry: [string, unknown] = ['message', 'safe']; let sink: unknown; let other: unknown; return Object.fromEntries([entry], ([sink, ...[{ ['field']: entry[1] }]] = [error, { field: 'kept' }])); }`,
    key: 'message',
    values: ["'kept':", "'safe':"],
  },
  {
    id: 'rest-member-keeps-an-array-value',
    source: `function frames(error: Error, list: unknown[], name: string) { const entry: [string, unknown] = ['message', 'safe']; let sink: unknown; let other: unknown; return Object.fromEntries([entry], ([sink, ...entry[1]] = [0, error])); }`,
    key: 'message',
    values: ["'safe':", '[0, error]:'],
  },
  {
    id: 'rest-member-empty-suffix-keeps-an-array-value',
    source: `function frames(error: Error, list: unknown[], name: string) { const entry: [string, unknown] = ['message', 'safe']; let sink: unknown; let other: unknown; return Object.fromEntries([entry], ([sink, ...entry[1]] = [0])); }`,
    key: 'message',
    values: ["'safe':", '[0]:'],
  },
  {
    id: 'rest-pattern-after-spread-keeps-elements',
    source: `function frames(error: Error, list: unknown[], name: string) { const entry: [string, unknown] = ['message', 'safe']; let sink: unknown; let other: unknown; return Object.fromEntries([entry], ([sink, ...[entry[1]]] = [...list, error])); }`,
    key: 'message',
    values: ["'safe':", '[...list, error]:', 'error:', 'list:0'],
  },
  {
    id: 'computed-key-aliased-changed-constant-spread-keeps-field',
    source: `function frames(error: Error, list: unknown[], name: string) { const entry: [string, unknown] = ['message', 'safe']; let sink: unknown; let other: unknown; const base: { field?: string } = { field: 'kept' }; const alias = base; delete base.field; return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: error, ...alias })); }`,
    key: 'message',
    values: ["'kept':", 'alias:', 'alias:0', 'base:', 'base:0', 'entry:1', 'error:'],
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
