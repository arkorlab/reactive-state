import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A spread the compile cannot expand still hands `Object.fromEntries` entries: each element it
 * yields is a tuple whose value slot, `1`, may land under the selected key — not a field of that
 * name on the spread iterable itself.
 */
const CASES = [
  {
    id: 'reviewed-overwriting-spread',
    source:
      "function frames(entries: [string, Error][]) { return Object.fromEntries([['message', 'safe'], ...entries]); }",
    key: 'message',
    values: ["'safe':", 'entries:0.1'],
  },
  {
    id: 'reviewed-only-spread',
    source:
      'function frames(entries: [string, Error][]) { return Object.fromEntries([...entries]); }',
    key: 'message',
    values: ['entries:0.1'],
  },
  {
    id: 'closed-tuple-spread',
    source:
      "function frames(entries: readonly [readonly ['a', Error], readonly ['b', string]]) { return Object.fromEntries([...entries]); }",
    key: 'a',
    values: ['entries:0.1', 'entries:1.1'],
  },
  {
    id: 'written-spread-pin',
    source:
      "function frames(error: Error) { return Object.fromEntries([...[['message', error]]]); }",
    key: 'message',
    values: ['error:'],
  },
  {
    id: 'later-definite-entry-pin',
    source:
      "function frames(entries: [string, Error][]) { return Object.fromEntries([...entries, ['message', 'safe']]); }",
    key: 'message',
    values: ["'safe':"],
  },
] as const;

describe('entry values an opaque spread hands Object.fromEntries', () => {
  it.each(CASES)('$id', ({ source, key, values }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'entry-spread-values.ts', source);
    const call = entriesCall(parsed.sourceFile);
    const selected = framedEntryValues(call, key)?.map(
      (each) => `${each.value.getText()}:${each.keys.join('.')}`,
    );

    expect(selected).toStrictEqual(values);
  });
});

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
