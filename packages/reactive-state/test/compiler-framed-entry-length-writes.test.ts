import { type CallExpression, isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A write to the `length` of an entry's tuple, while the arguments of `Object.fromEntries` are
 * evaluated, cuts the tuple short: its key slot may go, and the entry then installs `undefined` under
 * `'undefined'`, and leaves what an earlier entry installed under the key as it was. The key of the
 * entry is no longer one the compile can take as the one it was written with, as for a write to slot
 * `0`. A write to the value slot alone leaves the key.
 */
const HEAD =
  "declare const earlier: Error; function frames(error: Error, flag: boolean) { const entry: any = ['message', 'safe']; return Object.fromEntries([['message', earlier], entry, (";
const TAIL = ", ['other', 0])]); }";

const WRITES = [
  { id: 'length-emptied', write: 'entry.length = 0', keyed: true },
  { id: 'length-cut-to-the-key', write: 'entry.length = 1', keyed: true },
  { id: 'length-assigned-an-opaque-value', write: 'entry.length = flag ? 0 : 2', keyed: true },
  { id: 'length-reduced', write: 'entry.length -= 1', keyed: true },
  { id: 'length-reduced-by-a-logical-assignment', write: 'entry.length &&= 0', keyed: true },
  { id: 'length-decremented', write: 'entry.length--', keyed: true },
  { id: 'length-decremented-first', write: '--entry.length', keyed: true },
  { id: 'length-incremented', write: 'entry.length++', keyed: true },
  { id: 'length-by-text', write: "entry['length'] = 0", keyed: true },
  { id: 'length-in-an-array-pattern', write: '[entry.length] = [0]', keyed: true },
  { id: 'length-in-an-object-pattern', write: '({ cut: entry.length } = { cut: 0 })', keyed: true },
  { id: 'length-under-parentheses', write: '(entry.length) = 0', keyed: true },
  { id: 'length-of-a-cast-tuple', write: '(entry as any[]).length = 0', keyed: true },
  { id: 'length-of-a-non-null-tuple', write: 'entry!.length = 0', keyed: true },
  { id: 'length-in-a-branch', write: 'flag && (entry.length = 0)', keyed: true },
  { id: 'key-slot-written', write: "entry[0] = 'other'", keyed: true },
  { id: 'value-slot-written-pin', write: "entry[1] = 'other'", keyed: false },
  { id: 'length-of-another-array-pin', write: 'flag && ([].length = 0)', keyed: false },
  { id: 'length-read-pin', write: 'entry.length', keyed: false },
  { id: 'length-of-another-tuple-pin', write: "(frames.length = 0, 'other')", keyed: false },
  { id: 'no-write-pin', write: '0', keyed: false },
] as const;

describe('a write to the length of an entry tuple that the argument list evaluates', () => {
  it.each(WRITES)('$id', ({ write, keyed }) => {
    const source = `${HEAD}${write}${TAIL}`;

    expect(retainsEarlier(source)).toBe(keyed);
  });

  it('the length of an alias of the tuple, given as the entry', () => {
    const source = `declare const earlier: Error; function frames(flag: boolean) { const entry: any = ['message', 'safe']; const alias = entry; return Object.fromEntries([['message', earlier], alias, (alias.length = 0, ['other', 0])]); }`;

    expect(retainsEarlier(source)).toBe(true);
  });

  it('the length of an alias of the tuple, given as the entry, read only: a pin', () => {
    const source = `declare const earlier: Error; function frames(flag: boolean) { const entry: any = ['message', 'safe']; const alias = entry; return Object.fromEntries([['message', earlier], alias, (alias.length, ['other', 0])]); }`;

    expect(retainsEarlier(source)).toBe(false);
  });

  it('a short-circuited write is no write: a false condition skips it', () => {
    const source = `${HEAD}false && (entry.length = 0)${TAIL}`;

    expect(retainsEarlier(source)).toBe(false);
  });
});

/** Whether the value an earlier entry installs under `message` may stay, as the entry may not overwrite it. */
function retainsEarlier(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'entry-length-writes.ts', source);
  const found = framedEntryValues(entriesCall(parsed.sourceFile), 'message');
  if (found === undefined) throw new Error('the call is not followed');
  return found.some((each) => each.value.getText() === 'earlier');
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
