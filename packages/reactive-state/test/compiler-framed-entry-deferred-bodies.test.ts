import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A function the argument list only makes, and holds as data (an element of a list, the value of a
 * field, a branch), runs nowhere in it: what it does with the tuple is no write the list makes. One
 * that is called, given to a call, assigned or returned may run.
 */
const CASES = [
  {
    id: 'arrow-in-an-entry-that-calls-with-the-tuple',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', () => reviewed(entry)]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'function-expression-in-an-entry',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', function () { reviewed(entry); }]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'arrow-as-the-field-of-an-entry-value',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', { run: () => reviewed(entry) }]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'arrow-in-a-branch',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', flag ? () => reviewed(entry) : null]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'arrow-in-a-cast',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', (() => reviewed(entry)) as unknown]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'arrow-with-a-nested-arrow',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', () => () => reviewed(entry)]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'arrow-given-to-the-call-itself',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], () => reviewed(entry)); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'arrow-called-at-once',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, (() => reviewed(entry))()]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'arrow-given-to-a-call',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, [1].map(() => reviewed(entry))]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'arrow-assigned-and-called',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; let run: unknown; return Object.fromEntries([entry, ((run = () => reviewed(entry)), (run as () => void)())]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'arrow-given-to-a-new-object',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, new Promise(() => reviewed(entry))]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'arrow-returned-by-one-called-at-once',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, (() => () => reviewed(entry))()()]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'call-with-the-tuple-outside-any-function',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, reviewed(entry)]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'arrow-that-reads-the-tuple-pin',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', () => entry[0]]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'stored-arrow-with-an-unrelated-call-in-the-list',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', () => reviewed(entry)], ['count', Math.abs(-1)]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'stored-arrow-with-an-unrelated-new-in-the-list',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', () => reviewed(entry)], ['when', new Date(0)]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'stored-function-that-writes-the-tuple-with-an-unrelated-call',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', () => { entry[1] = error; }], ['count', Math.abs(-1)]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'stored-arrow-in-a-field-with-an-unrelated-call',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', { run: () => reviewed(entry) }], ['count', Math.abs(-1)]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'arrow-called-at-once-with-an-unrelated-call',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, (() => { entry[1] = error; })(), ['count', Math.abs(-1)]]); }",
    key: 'message',
    values: ["'safe':", '(() => { entry[1] = error; })():1', 'error:'],
  },
  {
    id: 'to-primitive-of-a-key-calls-with-the-tuple',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[{ [Symbol.toPrimitive]: () => (reviewed(entry), 'unused') }, 0], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'to-string-of-a-key-calls-with-the-tuple',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[{ toString: () => (reviewed(entry), 'unused') }, 0], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'value-of-of-a-key-calls-with-the-tuple',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[{ valueOf: () => (reviewed(entry), 'unused') }, 0], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'to-string-of-a-key-by-a-function-expression',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[{ toString: function () { reviewed(entry); return 'unused'; } }, 0], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'to-string-inherited-by-a-key',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[{ __proto__: { toString: () => (reviewed(entry), 'unused') } }, 0], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'to-string-of-a-key-in-a-nested-field',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[{ a: { toString: () => (reviewed(entry), 'unused') } }, 0], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-in-the-value-slot-pin',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', { toString: () => (reviewed(entry), 'unused') }]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'function-as-the-key-pin',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[() => reviewed(entry), 0], entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'hook-in-an-object-that-is-no-entry-pin',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], { toString: () => (reviewed(entry), 'unused') }); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'field-of-a-value-in-an-entry-before-the-tuple',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['unused', { run: () => reviewed(entry) }], entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'field-of-a-value-in-an-entry-after-the-tuple',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['unused', { run: () => reviewed(entry) }]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'field-of-a-value-in-an-entry-between-others',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['a', 1], ['unused', { run: () => reviewed(entry) }], entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'field-of-a-value-in-the-first-of-two-entries',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['unused', { run: () => reviewed(entry) }], ['b', 2], entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'arrow-in-a-value-in-the-first-entry-pin',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['unused', () => reviewed(entry)], entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'hook-of-the-key-of-the-second-entry',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, [{ toString: () => (reviewed(entry), 'k') }, 0]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-of-the-third-entry',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['a', 1], entry, [{ toString: () => (reviewed(entry), 'k') }, 0]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-of-an-object-entry-after-the-tuple',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { 0: { toString: () => (reviewed(entry), 'k') }, 1: 2 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-of-an-object-entry-before-the-tuple',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ 0: { toString: () => (reviewed(entry), 'k') }, 1: 2 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-of-an-object-entry-by-a-text-name',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { '0': { toString: () => (reviewed(entry), 'k') }, 1: 2 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-of-an-object-entry-by-an-unread-name',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { [String(flag)]: { toString: () => (reviewed(entry), 'k') }, 1: 2 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-of-an-object-entry-by-a-spread',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { ...{ 0: { toString: () => (reviewed(entry), 'k') } }, 1: 2 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-of-an-object-entry-by-an-accessor',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { get 0() { return { toString: () => (reviewed(entry), 'k') }; }, 1: 2 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-of-an-entry-in-a-spread-list',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ...[[{ toString: () => (reviewed(entry), 'k') }, 0]]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-of-an-entry-in-a-condition',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, flag ? [{ toString: () => (reviewed(entry), 'k') }, 0] : ['a', 1]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-of-an-entry-after-a-comma',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, (0, [{ toString: () => (reviewed(entry), 'k') }, 0])]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-of-an-entry-through-a-logical-operand',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, flag && [{ toString: () => (reviewed(entry), 'k') }, 0]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-of-an-entry-with-a-spread',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, [...['a', { toString: () => (reviewed(entry), 'k') }]]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-key-in-a-list-held-by-a-condition',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries(flag ? [entry, [{ toString: () => (reviewed(entry), 'k') }, 0]] : [entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-the-value-of-an-object-entry-pin',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { 0: 'a', 1: { toString: () => (reviewed(entry), 'k') } }]); }",
    key: 'message',
    values: ["'safe':", "{ 0: 'a', 1: { toString: () => (reviewed(entry), 'k') } }:1"],
  },
  {
    id: 'hook-of-the-value-of-an-entry-in-a-spread-list-pin',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ...[['a', { toString: () => (reviewed(entry), 'k') }]]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'hook-of-the-value-of-an-entry-in-a-condition-pin',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, flag ? ['a', { toString: () => (reviewed(entry), 'k') }] : ['b', 1]]); }",
    key: 'message',
    values: ["'safe':", "flag ? ['a', { toString: () => (reviewed(entry), 'k') }] : ['b', 1]:1"],
  },
  {
    id: 'hook-of-a-field-the-object-entry-names-1-pin',
    source:
      "function frames(error: Error, flag: boolean, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { 0: 'a', 1: { run: () => reviewed(entry) } }]); }",
    key: 'message',
    values: ["'safe':", "{ 0: 'a', 1: { run: () => reviewed(entry) } }:1"],
  },
  {
    id: 'hook-of-a-key-the-prototype-has',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ __proto__: { 0: { toString: () => (reviewed(entry), 'k') } }, 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-the-prototype-has-after-the-tuple',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { __proto__: { 0: { toString: () => (reviewed(entry), 'k') } }, 1: 0 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-the-prototype-of-the-prototype-has',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { __proto__: { __proto__: { 0: { toString: () => (reviewed(entry), 'k') } } }, 1: 0 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-a-list-prototype-has',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { __proto__: [{ toString: () => (reviewed(entry), 'k') }, 'x'], 1: 0 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-a-conditional-prototype-has',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { __proto__: flag ? { 0: { toString: () => (reviewed(entry), 'k') } } : null, 1: 0 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-the-prototype-has-by-a-text-name',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { '__proto__': { 0: { toString: () => (reviewed(entry), 'k') } }, 1: 0 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-a-spread-brings',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { ...{ 0: { toString: () => (reviewed(entry), 'k') } }, 1: 0 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-a-spread-of-a-list-brings',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { ...[{ toString: () => (reviewed(entry), 'k') }], 1: 0 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-a-spread-through-a-condition-brings',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { ...(flag ? { 0: { toString: () => (reviewed(entry), 'k') } } : {}), 1: 0 }]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-set-by-a-prototype-written-by-a-call',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, Object.setPrototypeOf({ 1: 0 }, { 0: { toString: () => (reviewed(entry), 'k') } })]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-the-prototype-an-object-create-gives',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, Object.create({ 0: { toString: () => (reviewed(entry), 'k') } })]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'prototype-given-by-a-name-holds-no-function-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { __proto__: proto, 1: 0 }]); }",
    key: 'message',
    values: ["'safe':", '{ __proto__: proto, 1: 0 }:1'],
  },
  {
    id: 'function-as-the-key-a-spread-brings-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { ...{ 0: () => reviewed(entry) }, 1: 0 }]); }",
    key: 'message',
    values: ["'safe':", '{ ...{ 0: () => reviewed(entry) }, 1: 0 }:1'],
  },
  {
    id: 'function-as-the-key-the-prototype-has-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { __proto__: { 0: () => reviewed(entry) }, 1: 0 }]); }",
    key: 'message',
    values: ["'safe':", '{ __proto__: { 0: () => reviewed(entry) }, 1: 0 }:1'],
  },
  {
    id: 'hook-of-the-value-with-a-prototype-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { __proto__: { 1: { toString: () => (reviewed(entry), 'k') } }, 1: 0 }]); }",
    key: 'message',
    values: ["'safe':", "{ __proto__: { 1: { toString: () => (reviewed(entry), 'k') } }, 1: 0 }:1"],
  },
  {
    id: 'function-as-a-key-in-parentheses-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[(() => reviewed(entry)), 0], entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'function-as-a-key-after-a-comma-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[(0, () => reviewed(entry)), 0], entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'function-as-a-key-in-a-branch-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[flag ? () => reviewed(entry) : 'a', 0], entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'function-as-a-key-after-a-cast-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[(() => reviewed(entry)) as unknown, 0], entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'function-as-a-key-before-a-fallback-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[(() => reviewed(entry)) || 'a', 0], entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'function-as-the-key-of-an-object-entry-in-parentheses-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { 0: (() => reviewed(entry)), 1: 0 }]); }",
    key: 'message',
    values: ["'safe':", '{ 0: (() => reviewed(entry)), 1: 0 }:1'],
  },
  {
    id: 'hook-of-a-key-in-parentheses',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[({ toString: () => (reviewed(entry), 'k') }), 0], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-after-a-comma',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[(0, { toString: () => (reviewed(entry), 'k') }), 0], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-in-a-branch',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[flag ? { toString: () => (reviewed(entry), 'k') } : 'a', 0], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-after-a-cast',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[({ toString: () => (reviewed(entry), 'k') }) as unknown, 0], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-before-a-fallback',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([[{ toString: () => (reviewed(entry), 'k') } || 'a', 0], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'spread-getter-calls-a-sibling-function',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ ...{ run: () => reviewed(entry), get 0() { this.run(); return 'unused'; } }, 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'spread-getter-calls-a-sibling-function-by-a-text-key',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ ...{ run: () => reviewed(entry), get 0() { this['run'](); return 'unused'; } }, 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'spread-getter-calls-a-sibling-function-through-call',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ ...{ run: () => reviewed(entry), get 0() { this.run.call(this); return 'unused'; } }, 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'spread-getter-takes-a-sibling-function-apart',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ ...{ run: () => reviewed(entry), get 0() { const { run } = this; run(); return 'unused'; } }, 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'spread-getter-reads-a-sibling-function-by-reflect',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ ...{ run: () => reviewed(entry), get 0() { Reflect.get(this, 'run')(); return 'unused'; } }, 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'spread-getter-reads-another-getter-that-calls',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ ...{ run: () => reviewed(entry), get 0() { return this.k; }, get k() { this.run(); return 'unused'; } }, 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'spread-setter-holds-a-sibling-function',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ ...{ run: () => reviewed(entry), set 0(value: unknown) { this.run(); } }, 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'nested-spread-with-a-getter-and-a-function',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ ...{ ...{ run: () => reviewed(entry), get 0() { this.run(); return 'unused'; } } }, 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'spread-in-a-list-spread-with-a-getter-and-a-function',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([...[{ ...{ run: () => reviewed(entry), get 0() { this.run(); return 'unused'; } }, 1: 0 }], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'entry-getter-calls-a-sibling-function',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ get 0() { this.run(); return 'unused'; }, run: () => reviewed(entry), 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'entry-getter-of-the-value-calls-a-sibling-function',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ get 1() { this.run(); return 0; }, run: () => reviewed(entry), 0: 'unused' }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'entry-getter-calls-a-function-of-a-field',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ get 0() { this.n.run(); return 'unused'; }, n: { run: () => reviewed(entry) }, 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'prototype-getter-calls-a-function-the-entry-holds',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ __proto__: { get 0() { this.run(); return 'unused'; } }, run: () => reviewed(entry), 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'prototype-of-a-prototype-getter-calls-a-function-the-entry-holds',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ __proto__: { __proto__: { get 0() { this.run(); return 'unused'; } } }, run: () => reviewed(entry), 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'prototype-given-by-a-name-and-a-function-the-entry-holds',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ __proto__: proto, run: () => reviewed(entry), 1: 0 }, entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'accessor-in-the-object-of-a-value-holding-a-function',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['unused', { get x() { return this.run(); }, run: () => reviewed(entry) }], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'spread-of-an-object-without-accessors-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ ...{ run: () => reviewed(entry), 0: 'unused' }, 1: 0 }, entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'spread-of-an-object-with-a-method-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ ...{ run: () => reviewed(entry), m() { return this.run; }, 0: 'unused' }, 1: 0 }, entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'spread-of-an-object-whose-accessors-are-in-another-object-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ ...{ run: () => reviewed(entry) }, ...{ get 0() { return 'unused'; } }, 1: 0 }, entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'prototype-without-accessors-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ __proto__: { 0: 'unused' }, run: () => reviewed(entry), 1: 0 }, entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'prototype-null-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ __proto__: null, run: () => reviewed(entry), 0: 'unused', 1: 0 }, entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'function-in-another-entry-from-the-accessor-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ get 0() { return 'unused'; }, 1: 0 }, ['b', { run: () => reviewed(entry) }], entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'hook-of-a-key-in-an-iterable-given-by-a-spread',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries(...[[[{ toString: () => (reviewed(entry), 'k') }, 0], entry]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-after-the-tuple-in-an-iterable-given-by-a-spread',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries(...[[entry, [{ toString: () => (reviewed(entry), 'k') }, 0]]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-in-an-iterable-given-by-a-nested-spread',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries(...[...[[[{ toString: () => (reviewed(entry), 'k') }, 0], entry]]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-in-an-iterable-given-after-an-empty-spread',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries(...[], [[{ toString: () => (reviewed(entry), 'k') }, 0], entry]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-in-an-iterable-given-after-two-spreads',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries(...[], ...[[[{ toString: () => (reviewed(entry), 'k') }, 0], entry]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-of-an-object-entry-in-an-iterable-given-by-a-spread',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries(...[[entry, { 0: { toString: () => (reviewed(entry), 'k') }, 1: 0 }]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-the-prototype-has-in-an-iterable-given-by-a-spread',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries(...[[entry, { __proto__: { 0: { toString: () => (reviewed(entry), 'k') } }, 1: 0 }]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'hook-of-a-key-in-a-held-iterable-given-by-a-spread',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; const rows = [[{ toString: () => (reviewed(entry), 'k') }, 0], entry]; return Object.fromEntries(...[rows]); }",
    key: 'message',
    values: ['0:', 'entry:1'],
  },
  {
    id: 'hook-of-a-key-in-arguments-held-by-a-name',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; const given = [[[{ toString: () => (reviewed(entry), 'k') }, 0], entry]]; return Object.fromEntries(...given); }",
    key: 'message',
    values: ['0:', 'entry:1'],
  },
  {
    id: 'hook-of-a-key-in-an-iterable-given-by-a-condition-of-spreads',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries(...(flag ? [[[{ toString: () => (reviewed(entry), 'k') }, 0], entry]] : [[entry]])); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'function-in-a-value-in-an-iterable-given-by-a-spread-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries(...[[entry, ['unused', { run: () => reviewed(entry) }]]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'function-as-the-key-in-an-iterable-given-by-a-spread-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries(...[[[() => reviewed(entry), 0], entry]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'hook-in-an-argument-the-call-does-not-take-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], ...[[[{ toString: () => (reviewed(entry), 'k') }, 0]]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'hook-in-a-second-argument-the-call-does-not-take-pin',
    source:
      "function frames(error: Error, flag: boolean, proto: object, reviewed: (row: unknown) => void) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], [[{ toString: () => (reviewed(entry), 'k') }, 0]]); }",
    key: 'message',
    values: ["'safe':"],
  },
] as const;

describe('entry tuples a function of the argument list is given', () => {
  it.each(CASES)('$id', ({ source, key, values }) => {
    expect(selectedValues(source, key)).toStrictEqual(values);
  });
});

/** The values the source's `Object.fromEntries` call may install under the key, in text order. */
function selectedValues(source: string, key: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'deferred-bodies.ts', source);
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
