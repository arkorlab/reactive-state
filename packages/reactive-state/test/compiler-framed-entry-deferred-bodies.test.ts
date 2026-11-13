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
