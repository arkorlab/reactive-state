import { describe, expect, it, vi } from 'vitest';

import { fieldOperationOf } from '../src/authority/requests.ts';
import type { Json } from '../src/program.ts';

const CAPTURE_CHARACTERS = 4096;
const REPEATS = 64;

/** A valid field update around the captures under test. */
function request(captures: unknown) {
  return { binding: 'binding', captures, operationId: 'op-size', updaterId: 'update' };
}

/** An oversized capture object is refused before canonicalization or normalization writes text. */
function serializations(captures: unknown): number {
  const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
    throw new Error('Rejected capture serialization must not run.');
  });
  try {
    expect(() => fieldOperationOf(request(captures))).toThrow('The update captured too much.');

    return stringify.mock.calls.length;
  } finally {
    stringify.mockRestore();
  }
}

describe('bounded field captures before serialization', () => {
  it.each([1000, 200_000])('bounds repeated sparse arrays of length %s', (length) => {
    const sparse: Json[] = [];
    sparse.length = length;
    const captures = Object.fromEntries(
      Array.from({ length: REPEATS }, (_, index) => [String(index), sparse]),
    );

    expect(serializations(captures)).toBe(0);
    expect(Object.hasOwn(sparse, 0)).toBe(false);
  });

  it.each(['x', '界', '😀', '\0', '\u{D800}'])(
    'preserves the exact canonical character boundary with %j',
    (unit) => {
      const captures = { text: '' };
      const envelope = JSON.stringify(captures).length;
      const width = JSON.stringify(unit).length - 2;
      captures.text = unit.repeat(Math.floor((CAPTURE_CHARACTERS - envelope) / width));
      captures.text += 'x'.repeat(CAPTURE_CHARACTERS - JSON.stringify(captures).length);

      expect(fieldOperationOf(request(captures)).captures).toStrictEqual(captures);

      captures.text += 'x';

      expect(serializations(captures)).toBe(0);
    },
  );

  it('normalizes accepted sparse captures like their HTTP representation', () => {
    const sparse: Json[] = [];
    sparse.length = 2;
    sparse[1] = { gone: undefined, zero: -0 } as unknown as Json;
    const update = request({ sparse });
    const text = JSON.stringify(update);
    const http: unknown = JSON.parse(text);

    expect(fieldOperationOf(update)).toStrictEqual(fieldOperationOf(http));
    expect(fieldOperationOf(update).captures).toStrictEqual({ sparse: [null, { zero: 0 }] });
    expect(Object.hasOwn(sparse, 0)).toBe(false);
  });

  it('preserves absent captures and malformed capture refusals', () => {
    expect(fieldOperationOf(request(undefined))).not.toHaveProperty('captures');
    expect(() => fieldOperationOf(request({ value: new Date(0) }))).toThrow(
      'The operation is not valid.',
    );
  });
});
