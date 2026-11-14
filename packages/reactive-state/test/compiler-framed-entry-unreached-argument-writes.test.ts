import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A slot write in `Object.fromEntries`'s arguments counts only where their evaluation may reach it:
 * a written condition or short-circuit that the code shows skips it leaves the tuple as written.
 */
const ENTRY = "const entry: [string, unknown] = ['message', 'safe'];";

const CASES = [
  {
    id: 'reviewed-false-and',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], false && (entry[1] = error)); }`,
    values: ["'safe':"],
  },
  {
    id: 'true-or',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], true || (entry[1] = error)); }`,
    values: ["'safe':"],
  },
  {
    id: 'false-conditional',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], false ? (entry[1] = error) : 0); }`,
    values: ["'safe':"],
  },
  {
    id: 'date-condition',
    source: `function frames(error: Error) { const date = new Date(0); ${ENTRY} return Object.fromEntries([entry], date.setTime(1), date.getTime() && (entry[1] = error)); }`,
    values: ["'safe':", 'error:'],
  },
  {
    id: 'date-conditional',
    source: `function frames(error: Error) { const date = new Date(0); ${ENTRY} return Object.fromEntries([entry], date.setTime(1), date.getTime() ? (entry[1] = error) : 0); }`,
    values: ["'safe':", 'error:'],
  },
  {
    id: 'constant-alias',
    source: `function frames(error: Error) { const never = false; ${ENTRY} return Object.fromEntries([entry], never && (entry[1] = error)); }`,
    values: ["'safe':", 'error:'],
  },
  {
    id: 'negated-literal-pin',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], !true && (entry[1] = error)); }`,
    values: ["'safe':"],
  },
  {
    id: 'opaque-condition-pin',
    source: `function frames(error: Error, flag: boolean) { ${ENTRY} return Object.fromEntries([entry], flag && (entry[1] = error)); }`,
    values: ["'safe':", 'error:'],
  },
  {
    id: 'true-and-pin',
    source: `function frames(error: Error) { ${ENTRY} return Object.fromEntries([entry], true && (entry[1] = error)); }`,
    values: ["'safe':", 'error:'],
  },
] as const;

describe('entry tuple writes the argument list never reaches', () => {
  it.each(CASES)('$id', ({ source, values }) => {
    expect(selectedValues(source, 'message')).toStrictEqual(values);
  });
});

/** The values the source's `Object.fromEntries` call may install under the key, in text order. */
function selectedValues(source: string, key: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'entry-unreached-argument-writes.ts', source);
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
