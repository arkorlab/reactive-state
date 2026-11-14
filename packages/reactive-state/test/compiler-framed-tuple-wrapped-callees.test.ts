import { type CallExpression, isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A call of a method an entry's tuple has runs with the tuple as `this`, and may write any slot of
 * it before `Object.fromEntries` reads it: a call the compile does not follow is refused. What
 * wraps the callee in the code (parentheses, a cast, `!`, `satisfies`) is no other call.
 */
const HEAD =
  "function frames(error: Error) { const entry: any = ['message', 'safe']; entry.change = function () { this[1] = error; };";

const CALLS = [
  { id: 'direct', call: 'entry.change()', followed: false },
  { id: 'element-access', call: "entry['change']()", followed: false },
  { id: 'optional-call', call: 'entry.change?.()', followed: false },
  { id: 'optional-member', call: 'entry?.change()', followed: false },
  { id: 'parenthesized-tuple', call: '(entry).change()', followed: false },
  { id: 'cast-tuple', call: '(entry as any).change()', followed: false },
  { id: 'parenthesized-callee', call: '(entry.change)()', followed: false },
  { id: 'twice-parenthesized-callee', call: '((entry.change))()', followed: false },
  { id: 'cast-callee', call: '(entry.change as () => void)()', followed: false },
  { id: 'non-null-callee', call: 'entry.change!()', followed: false },
  { id: 'satisfies-callee', call: '(entry.change satisfies () => void)()', followed: false },
  { id: 'angle-cast-callee', call: '(<() => void>entry.change)()', followed: false },
  { id: 'parenthesized-element-access-callee', call: "(entry['change'])()", followed: false },
  { id: 'cast-element-access-callee', call: "(entry['change'] as () => void)()", followed: false },
  { id: 'parenthesized-optional-callee', call: '(entry.change)?.()', followed: false },
  {
    id: 'parenthesized-callee-with-a-cast-tuple',
    call: '((entry as any).change)()',
    followed: false,
  },
  { id: 'tracked-push-pin', call: "entry.push('x')", followed: true },
  { id: 'tracked-push-parenthesized-pin', call: "(entry.push)('x')", followed: true },
  { id: 'tracked-push-cast-pin', call: "(entry.push as any)('x')", followed: true },
  { id: 'tracked-push-non-null-pin', call: "entry.push!('x')", followed: true },
  { id: 'member-read-pin', call: 'entry.length', followed: true },
  { id: 'member-read-parenthesized-pin', call: '(entry.length)', followed: true },
  { id: 'member-read-cast-pin', call: '(entry.length as number)', followed: true },
] as const;

describe('a call of a method of an entry tuple, written under a wrapper', () => {
  it.each(CALLS)('$id', ({ call, followed }) => {
    const source = `${HEAD} return Object.fromEntries([entry, (${call}, ['other', 0])]); }`;

    expect(isFollowed(source)).toBe(followed);
  });

  it.each(CALLS)('$id, where it rewrites the key', ({ call, followed }) => {
    const source = `function frames(error: Error) { const entry: any = ['other', error]; entry.change = function () { this[0] = 'message'; }; return Object.fromEntries([entry, (${call}, ['x', 0])]); }`;

    expect(isFollowed(source)).toBe(followed);
  });
});

/** Whether the compile follows what the source's `Object.fromEntries` call may install under `message`. */
function isFollowed(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'tuple-wrapped-callees.ts', source);
  return framedEntryValues(entriesCall(parsed.sourceFile), 'message') !== undefined;
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
