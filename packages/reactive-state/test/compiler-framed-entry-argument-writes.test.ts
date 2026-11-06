import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `Object.fromEntries` reads each entry only after its whole argument list is evaluated, the
 * arguments it ignores included: a slot that evaluation writes on an entry's tuple may be the key or
 * the value it installs.
 */
const CASES = [
  {
    id: 'reviewed-value-slot',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, ((entry[1] = error), ['other', 0])]); }",
    key: 'message',
    values: ["'safe':", "(entry[1] = error), ['other', 0]:1", 'error:'],
  },
  {
    id: 'packed-tuple-value-slot',
    source:
      "function frames(error: Error) { const row = ['failure', { stack: 'fixed' }] as const; const entries = [row] as const; return Object.fromEntries([...entries], ((row as any)[1] = error)); }",
    key: 'failure',
    values: ["{ stack: 'fixed' }:", 'error:'],
  },
  {
    id: 'key-slot',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['other', error]; return Object.fromEntries([entry], (entry[0] = 'message')); }",
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'opaque-slot',
    source:
      "function frames(error: Error, slot: number) { const entry: [string, unknown] = ['other', 'safe']; return Object.fromEntries([entry], (entry[slot] = error)); }",
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'immediate-call',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], (() => { entry[1] = error; })()); }",
    key: 'message',
    values: ["'safe':", 'error:'],
  },
  {
    id: 'uncalled-function-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], () => { entry[1] = error; }); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'other-tuple-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const other: [string, unknown] = ['x', 0]; return Object.fromEntries([entry], (other[1] = error)); }",
    key: 'message',
    values: ["'safe':"],
  },
] as const;

describe('entry tuple slots the argument list writes', () => {
  it.each(CASES)('$id', ({ source, key, values }) => {
    expect(selectedValues(source, key)).toStrictEqual(values);
  });
});

/** The values the source's `Object.fromEntries` call may install under the key, in text order. */
function selectedValues(source: string, key: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'entry-argument-writes.ts', source);
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
