import { describe, expect, it } from 'vitest';

import { Dependencies } from '../src/authority/dependencies.ts';
import { Memo, type MemoEntry } from '../src/authority/memo.ts';

/** How long the memos below keep a rendering, by their own clock. */
const TTL_MS = 1000;

/** A rendering of its own, told apart from another by identity. */
function rendering(): MemoEntry {
  return { dependencies: new Dependencies(), instances: 1, output: { kind: 'refused' } };
}

describe('the memo at its limit', () => {
  it('lets go of an expired rendering before a live one, though the expired one was read since', () => {
    let now = 0;
    const memo = new Memo(() => now, 2, TTL_MS);
    const [first, second, third] = [rendering(), rendering(), rendering()];
    memo.set('first', first);
    now = 500;
    memo.set('second', second);
    now = 600;
    // Read, `first` is the most recently used; it expires when it was made to, all the same.
    const read = memo.get('first');
    now = TTL_MS;

    memo.set('third', third);

    expect(read).toBe(first);
    expect(memo.get('second')).toBe(second);
    expect(memo.get('third')).toBe(third);
    expect(memo.get('first')).toBeUndefined();
    expect(memo.size).toBe(2);
  });

  it('lets go of the least recently used rendering where none expired', () => {
    let now = 0;
    const memo = new Memo(() => now, 2, TTL_MS);
    const [first, second, third] = [rendering(), rendering(), rendering()];
    memo.set('first', first);
    memo.set('second', second);
    now = 10;
    // Read, `first` is the most recently used, and `second` the least.
    const read = memo.get('first');

    memo.set('third', third);

    expect(read).toBe(first);
    expect(memo.get('second')).toBeUndefined();
    expect(memo.get('first')).toBe(first);
    expect(memo.get('third')).toBe(third);
  });
});
