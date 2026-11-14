import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A tuple handed to a native array method called on another array is let go: it stays in that array,
 * and a later write through the array reaches the tuple under no name the compile follows. Only a
 * borrowed call on the tuple's own array is a write the compile reads.
 */
const CASES = [
  {
    id: 'push-call-into-another-array',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const saved: unknown[] = []; return Object.fromEntries([entry], Array.prototype.push.call(saved, entry)); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'push-apply-into-another-array',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const saved: unknown[] = []; return Object.fromEntries([entry], Array.prototype.push.apply(saved, [entry])); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'reflect-apply-push-into-another-array',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const saved: unknown[] = []; return Object.fromEntries([entry], Reflect.apply(Array.prototype.push, saved, [entry])); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'unshift-call-into-another-array',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const saved: unknown[] = []; return Object.fromEntries([entry], Array.prototype.unshift.call(saved, entry)); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'splice-call-into-another-array',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const saved: unknown[] = []; return Object.fromEntries([entry], Array.prototype.splice.call(saved, 0, 0, entry)); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'fill-call-into-another-array',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const saved: unknown[] = []; return Object.fromEntries([entry], Array.prototype.fill.call(saved, entry)); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'bound-push-into-another-array',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const saved: unknown[] = []; return Object.fromEntries([entry], Array.prototype.push.bind(saved)(entry)); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'push-call-into-a-condition',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const saved: unknown[] = []; return Object.fromEntries([entry], Array.prototype.push.call(error ? saved : entry, 'x')); }",
    key: 'message',
    values: undefined,
  },
  {
    id: 'push-call-into-the-tuple-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const saved: unknown[] = []; return Object.fromEntries([entry], Array.prototype.push.call(entry, 'x')); }",
    key: 'message',
    values: ["'safe':", "'x':"],
  },
  {
    id: 'push-call-into-another-array-without-the-tuple-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const saved: unknown[] = []; return Object.fromEntries([entry], Array.prototype.push.call(saved, 'x')); }",
    key: 'message',
    values: ["'safe':"],
  },
] as const;

describe('entry tuples a borrowed array method is given', () => {
  it.each(CASES)('$id', ({ source, key, values }) => {
    expect(selectedValues(source, key)).toStrictEqual(values);
  });
});

/** The values the source's `Object.fromEntries` call may install under the key, in text order. */
function selectedValues(source: string, key: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'borrowed-receivers.ts', source);
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
