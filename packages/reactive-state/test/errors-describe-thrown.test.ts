import { describe, expect, it } from 'vitest';

import { describeThrown } from '../src/authority/errors.ts';

/** What `describeThrown` answers for a value whose conversion to text throws. */
const UNSAID = 'a value that does not say what it is';

/** A value whose conversion to text throws, as an application's object may. */
const UNSPEAKABLE = {
  toString(): string {
    throw new Error('no text');
  },
};

/** An error of the message `failed` whose `stack` was set to `stack`, as any code may set it. */
function stacked(stack: unknown): Error {
  const error = new Error('failed');
  Object.defineProperty(error, 'stack', { value: stack });
  return error;
}

describe('describeThrown', () => {
  it('answers an error by its stack, or by its message where it has none', () => {
    const error = new Error('failed');

    expect(describeThrown(error)).toBe(error.stack);
    expect(describeThrown(stacked(undefined))).toBe('failed');
  });

  it('answers a stack set to anything but text as text', () => {
    expect(describeThrown(stacked(42))).toBe('42');
    expect(describeThrown(stacked({ frames: 3 }))).toBe('[object Object]');
  });

  it('answers a stack whose conversion throws as a value that does not say what it is', () => {
    const described = describeThrown(stacked(UNSPEAKABLE));

    // As its callers write it into a log line, outside its `try`.
    expect(`logged: ${described}`).toBe(`logged: ${UNSAID}`);
    expect(described).toBe(UNSAID);
  });

  it('answers any other value as its text, or as one that does not say what it is', () => {
    expect(describeThrown('plain')).toBe('plain');
    expect(describeThrown(Symbol('thrown'))).toBe('Symbol(thrown)');
    expect(describeThrown(UNSPEAKABLE)).toBe(UNSAID);
  });
});
