import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A call or a new object in the argument list is counted as work that may run, whether or not the
 * list reaches it: a call a short circuit or a branch a written condition rules out is no less a call
 * of a function of the module's that writes the tuple, and the tuple the list reads is not taken as it
 * was written. (Following the conditions that rule a call out is precision the reader does not keep.)
 */
const CASES = [
  {
    id: 'call-behind-a-false-short-circuit-is-counted',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], entry, ['unused', false && change()]]); return out; function change() { entry[0] = 'other'; } }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'call-behind-a-true-fallback-is-counted',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], entry, ['unused', true || change()]]); return out; function change() { entry[0] = 'other'; } }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'call-in-the-branch-a-literal-condition-rules-out-is-counted',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], entry, ['unused', 0 ? change() : 1]]); return out; function change() { entry[0] = 'other'; } }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'call-in-the-other-branch-a-literal-condition-rules-out-is-counted',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], entry, ['unused', 1 ? 1 : change()]]); return out; function change() { entry[0] = 'other'; } }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'new-behind-a-false-short-circuit-is-counted',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], entry, ['unused', false && new Change()]]); return out; function change() { entry[0] = 'other'; } class Change { constructor() { entry[0] = 'other'; } } }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'call-behind-a-negated-literal-is-counted',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], entry, ['unused', !true && change()]]); return out; function change() { entry[0] = 'other'; } }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'call-behind-a-short-circuit-that-may-run',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], entry, ['unused', flag && change()]]); return out; function change() { entry[0] = 'other'; } }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'call-behind-a-true-short-circuit',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], entry, ['unused', true && change()]]); return out; function change() { entry[0] = 'other'; } }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'call-in-a-branch-that-may-run',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], entry, ['unused', flag ? change() : 1]]); return out; function change() { entry[0] = 'other'; } }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'call-that-runs-outright',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], entry, ['unused', change()]]); return out; function change() { entry[0] = 'other'; } }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
] as const;

describe('entry tuples a call of the argument list may not reach', () => {
  it.each(CASES)('$id', ({ source, key, values }) => {
    expect(selectedValues(source, key)).toStrictEqual(values);
  });
});

/** The values the source's `Object.fromEntries` call may install under the key, in text order. */
function selectedValues(source: string, key: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'reachable-calls.ts', source);
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
