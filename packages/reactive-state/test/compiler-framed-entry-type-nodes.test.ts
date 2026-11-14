import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A type names the tuple without using it: a cast to `typeof entry`, the type of a parameter, of a
 * variable or of an alias. It is no place the tuple is let go to, no code that may write it, and no use
 * of it before the call; a use of the tuple as a value still is.
 */
const CASES = [
  {
    id: 'cast-to-typeof-the-tuple',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry as typeof entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'satisfies-typeof-the-tuple',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry satisfies typeof entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'typeof-the-tuple-in-a-generic',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['k', (null as unknown as Array<typeof entry>)]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'typeof-the-tuple-in-an-arrow-parameter',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['k', (row: typeof entry) => row]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'typeof-a-member-of-the-tuple',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['k', null as unknown as (typeof entry)[0]]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'typeof-the-tuple-after-a-call-in-the-list',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry as typeof entry, ['k', Math.abs(1)]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'typeof-the-tuple-in-a-function-elsewhere',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([entry, ['k', Math.abs(1)]]); function later(row: typeof entry) { return row; } return out; }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'typeof-the-tuple-in-a-type-alias-before-the-call',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; type Row = typeof entry; return Object.fromEntries([entry, ['k', Math.abs(1)]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'typeof-the-tuple-in-the-type-of-a-variable-before-the-call',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; let held: typeof entry | undefined; held = undefined; return Object.fromEntries([entry, ['k', Math.abs(1)]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'typeof-the-tuple-in-a-cast-before-the-call',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; const alias = null as unknown as typeof entry; void alias; return Object.fromEntries([entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'value-use-of-the-tuple-as-an-argument-pin',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ['k', String(entry)]]); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'value-use-of-the-tuple-before-the-call-pin',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; String(entry); return Object.fromEntries([entry]); }",
    key: 'message',
    values: ['entry:1'],
  },
  {
    id: 'value-use-of-the-tuple-in-a-function-elsewhere-is-exposed',
    source:
      "function frames(error: Error, flag: boolean, other: unknown) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([entry, ['k', Math.abs(1)]]); function later() { entry[1] = error; } return out; }",
    key: 'message',
    values: ['entry:1'],
  },
] as const;

describe('entry tuples a type names', () => {
  it.each(CASES)('$id', ({ source, key, values }) => {
    expect(selectedValues(source, key)).toStrictEqual(values);
  });
});

/** The values the source's `Object.fromEntries` call may install under the key, in text order. */
function selectedValues(source: string, key: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'type-nodes.ts', source);
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
