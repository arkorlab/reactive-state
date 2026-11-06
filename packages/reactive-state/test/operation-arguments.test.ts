import { describe, expect, it, vi } from 'vitest';

import { operationCallOf } from '../src/authority/requests.ts';
import type { Json, OperationArgument } from '../src/program.ts';

const ARGUMENT_CHARACTERS = 262_144;
const ARGUMENTS = 64;

/** A valid operation envelope around the arguments under test. */
function request(args: readonly OperationArgument[]) {
  return { args, build: 'test', module: 'test/echo', name: 'take', operationId: 'op-size' };
}

/** An oversized argument list must fail before any normalization writes JSON text. */
function serializations(args: readonly OperationArgument[]): number {
  const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
    throw new Error('Rejected argument serialization must not run.');
  });
  try {
    expect(() => operationCallOf(request(args))).toThrow(
      'An operation is sent 262144 characters of arguments at most, as JSON.',
    );

    return stringify.mock.calls.length;
  } finally {
    stringify.mockRestore();
  }
}

describe('bounded operation arguments before carrying', () => {
  it.each([200_000, 1000])(
    'bounds repeated sparse arrays of length %s before expansion',
    (length) => {
      const sparse: Json[] = [];
      sparse.length = length;
      const args = Array.from({ length: ARGUMENTS }, () => ({ json: sparse }));

      expect(serializations(args)).toBe(0);

      expect(Object.hasOwn(sparse, 0)).toBe(false);
    },
  );

  it('bounds the aggregate of individually valid escaped form values', () => {
    const form = [['name', '\0'.repeat(1000)]] as const;
    const args = Array.from({ length: ARGUMENTS }, () => ({ form }));

    expect(serializations(args)).toBe(0);
  });

  it.each(['x', '界', '😀', '\0', '\u{D800}'])(
    'preserves the exact serialized character boundary with %j',
    (unit) => {
      const args = [{ json: { text: '' } }];
      const envelope = JSON.stringify(args).length;
      const width = JSON.stringify(unit).length - 2;
      args[0]!.json.text = unit.repeat(Math.floor((ARGUMENT_CHARACTERS - envelope) / width));
      args[0]!.json.text += 'x'.repeat(ARGUMENT_CHARACTERS - JSON.stringify(args).length);

      expect(operationCallOf(request(args)).args).toStrictEqual(args);

      args[0]!.json.text += 'x';

      expect(serializations(args)).toBe(0);
    },
  );

  it('normalizes accepted sparse arguments identically to their HTTP representation', () => {
    const sparse: Json[] = [];
    sparse.length = 2;
    sparse[1] = { gone: undefined, zero: -0 } as unknown as Json;
    const args = [{ json: sparse }];
    const text = JSON.stringify(request(args));
    const http: unknown = JSON.parse(text);

    expect(operationCallOf(request(args))).toStrictEqual(operationCallOf(http));
    expect(operationCallOf(request(args)).args).toStrictEqual([{ json: [null, { zero: 0 }] }]);
    expect(Object.hasOwn(sparse, 0)).toBe(false);
  });

  it('preserves the argument count and malformed-value refusals', () => {
    const accepted = Array.from({ length: ARGUMENTS }, () => ({ json: null }));
    const excess = [...accepted, { json: null }];

    expect(operationCallOf(request(accepted)).args).toHaveLength(ARGUMENTS);
    expect(() => operationCallOf(request(excess))).toThrow('64 arguments at most');
    expect(() => operationCallOf({ ...request([]), args: [{ json: new Date(0) }] })).toThrow(
      'Each argument is sent',
    );
  });
});
