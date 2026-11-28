import { describe, expect, it } from 'vitest';

import { operationCallOf } from '../src/authority/requests.ts';
import { PREPARED_LIMIT } from '../src/program.ts';

/**
 * What `operationCallOf` makes of an operation's preparation (`OperationCall.prepared`): copied as
 * JSON carries it, kept as `null`, absent when absent, refused (413) past 4096 bytes of UTF-8 and
 * (400) where it is no JSON.
 */

/** A call whose preparation is `prepared`, the field left out where `undefined` is not given. */
function callWith(...prepared: readonly unknown[]): unknown {
  return {
    args: [],
    build: 'b',
    module: 'actions/prepared',
    name: 'echo',
    operationId: 'op-1',
    ...(prepared.length > 0 && { prepared: prepared[0] }),
  };
}

/** What `read` throws; a test fails when it throws nothing. */
function refusedWith(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  throw new Error('It was not refused.');
}

/** The JSON text of `bytes` bytes in UTF-8: 2000 characters of 2 bytes each, then plain text. */
function textOfBytes(bytes: number): string {
  const wide = 2000;
  const quotes = 2;
  return 'é'.repeat(wide) + 'a'.repeat(bytes - quotes - 2 * wide);
}

/** An object that holds itself. */
function cycle(): unknown {
  const self: Record<string, unknown> = {};
  self['self'] = self;
  return self;
}

describe('the preparation of an operation call', () => {
  it('is copied as JSON carries it', () => {
    const holes = [1, , 3]; // eslint-disable-line no-sparse-arrays -- a hole is what is read
    const sent = { holes, nested: { gone: undefined, kept: 1, zero: -0 } };

    const { prepared } = operationCallOf(callWith(sent));

    expect(prepared).toStrictEqual({ holes: [1, null, 3], nested: { kept: 1, zero: 0 } });
    expect(Object.is((prepared as { nested: { zero: number } }).nested.zero, 0)).toBe(true);
    expect(prepared).not.toBe(sent);
  });

  it('keeps null as null', () => {
    expect(operationCallOf(callWith(null))).toHaveProperty('prepared', null);
  });

  it('stays absent where it is absent, or undefined', () => {
    expect(operationCallOf(callWith())).not.toHaveProperty('prepared');
    expect(operationCallOf(callWith(undefined))).not.toHaveProperty('prepared');
  });

  it('is no part of what the call keeps beside its own fields', () => {
    const call = operationCallOf({ ...(callWith('x') as Record<string, unknown>), extra: 1 });

    expect(Object.keys(call).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      'args',
      'build',
      'module',
      'name',
      'operationId',
      'prepared',
    ]);
  });

  it.each([
    ['plain text', 'a'.repeat(PREPARED_LIMIT - 2), 'a'.repeat(PREPARED_LIMIT - 1)],
    ['2-byte characters', textOfBytes(PREPARED_LIMIT), textOfBytes(PREPARED_LIMIT + 1)],
    [
      '3-byte characters',
      'あ'.repeat(1364) + 'a'.repeat(PREPARED_LIMIT - 2 - 3 * 1364),
      'あ'.repeat(1364) + 'a'.repeat(PREPARED_LIMIT - 1 - 3 * 1364),
    ],
  ])('takes 4096 bytes and refuses 4097, counted in UTF-8: %s', (_name, fits, over) => {
    expect(new TextEncoder().encode(JSON.stringify(fits)).byteLength).toBe(PREPARED_LIMIT);
    expect(new TextEncoder().encode(JSON.stringify(over)).byteLength).toBe(PREPARED_LIMIT + 1);

    expect(operationCallOf(callWith(fits))).toHaveProperty('prepared', fits);
    expect(refusedWith(() => operationCallOf(callWith(over)))).toMatchObject({
      code: 'TOO_LARGE',
      status: 413,
    });
  });

  it.each([
    ['a function', cycle],
    ['a date', new Date(0)],
    ['NaN', NaN],
    ['a cycle', cycle()],
  ])('is refused (400) where it is no JSON: %s', (_name, value) => {
    expect(refusedWith(() => operationCallOf(callWith(value)))).toMatchObject({
      code: 'INVALID_OPERATION',
      status: 400,
    });
  });
});
