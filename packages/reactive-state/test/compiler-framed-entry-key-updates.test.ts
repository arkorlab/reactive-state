import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `Object.fromEntries` reads each entry after its whole argument list is evaluated: a step, a
 * deletion, a compound assignment or a pattern that evaluation writes to the key slot of an entry's
 * tuple may change the key it is installed under, so what an earlier entry wrote under the key it had
 * stays, and what the tuple's value was is one it may install under any key.
 */
const CASES = [
  {
    id: 'postfix-increment-of-the-key',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, (entry[0]++, ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "entry[0]++, ['other', 0]:1", 'error:'],
  },
  {
    id: 'prefix-increment-of-the-key',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, (++entry[0], ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "++entry[0], ['other', 0]:1", 'error:'],
  },
  {
    id: 'postfix-decrement-of-the-key',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, (entry[0]--, ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "entry[0]--, ['other', 0]:1", 'error:'],
  },
  {
    id: 'prefix-decrement-of-the-key',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, (--entry[0], ['other', 0])]); }",
    key: '1',
    values: ["--entry[0], ['other', 0]:1", "'safe':", 'error:'],
  },
  {
    id: 'parenthesized-increment-of-the-key',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, ((entry[0])++, ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "(entry[0])++, ['other', 0]:1", 'error:'],
  },
  {
    id: 'cast-increment-of-the-key',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, ((entry as any)[0]++, ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "(entry as any)[0]++, ['other', 0]:1", 'error:'],
  },
  {
    id: 'increment-of-an-opaque-slot',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, (entry[slot]++, ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "entry[slot]++, ['other', 0]:1", 'error:'],
  },
  {
    id: 'delete-of-the-key',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, (delete (entry as any)[0], ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "delete (entry as any)[0], ['other', 0]:1", 'error:'],
  },
  {
    id: 'compound-assignment-of-the-key',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, ((entry[0] += 1), ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "(entry[0] += 1), ['other', 0]:1", 'error:'],
  },
  {
    id: 'logical-assignment-of-the-key',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, ((entry[0] ??= 2), ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "(entry[0] ??= 2), ['other', 0]:1", 'error:'],
  },
  {
    id: 'pattern-target-for-the-key',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, ([entry[0]] = [2], ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "[entry[0]] = [2], ['other', 0]:1", 'error:'],
  },
  {
    id: 'loop-head-for-the-key',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, (() => { for (entry[0] of [2]) { } return ['other', 0]; })()]); }",
    key: '1',
    values: ["'safe':", "(() => { for (entry[0] of [2]) { } return ['other', 0]; })():1", 'error:'],
  },
  {
    id: 'increment-of-the-value-slot',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, (entry[1]++, ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "entry[1]++, ['other', 0]:1"],
  },
  {
    id: 'increment-of-another-tuple-pin',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; const other: [number, unknown] = [3, 0]; return Object.fromEntries([['1', error], entry, (other[0]++, ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "other[0]++, ['other', 0]:1"],
  },
  {
    id: 'delete-of-another-tuple-pin',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; const other: [number, unknown] = [3, 0]; return Object.fromEntries([['1', error], entry, (delete (other as any)[0], ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "delete (other as any)[0], ['other', 0]:1"],
  },
  {
    id: 'read-of-the-key-pin',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, (entry[0], ['other', 0])]); }",
    key: '1',
    values: ["'safe':", "entry[0], ['other', 0]:1"],
  },
  {
    id: 'negation-of-the-key-pin',
    source:
      "function frames(error: Error, slot: number) { const entry: [number, unknown] = [1, 'safe']; return Object.fromEntries([['1', error], entry, (-entry[0], ['other', 0])]); }",
    key: '1',
    values: ["-entry[0], ['other', 0]:1", "'safe':"],
  },
] as const;

describe('entry key slots the argument list steps, deletes and assigns', () => {
  it.each(CASES)('$id', ({ source, key, values }) => {
    expect(selectedValues(source, key)).toStrictEqual(values);
  });
});

/** The values the source's `Object.fromEntries` call may install under the key, in text order. */
function selectedValues(source: string, key: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'entry-key-updates.ts', source);
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
