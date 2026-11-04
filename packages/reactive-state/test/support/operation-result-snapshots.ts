import { describe, expect, it } from 'vitest';

import type { AuthorityEngine } from '../../src/authority/engine.ts';
import { MAX_CARRIED_BYTES } from '../../src/authority/json-size.ts';
import { operationResult } from '../../src/authority/operation-results.ts';
import { resultReceipts } from './operation-result-slots.ts';
import { BUILD } from './program.ts';

interface Snapshot {
  readonly value: unknown;
  readonly expected: unknown;
  readonly commit?: boolean;
  readonly reads: string[];
  readonly descriptors?: Readonly<Record<string, number>>;
  readonly expectedDescriptors?: Readonly<Record<string, number>>;
}

const LIMITS = { depth: 64, third: 3, fourth: 4, nullSlot: 5 } as const;

/** A later property get cannot replace the own data captured for the receipt. */
function changedGet(after: () => unknown, commit = false): Snapshot {
  const reads: string[] = [];
  const value = new Proxy(
    { item: 'written' },
    {
      get(target, key, receiver): unknown {
        if (key !== 'item') return Reflect.get(target, key, receiver);
        reads.push('item');
        return reads.length === 1 ? 'written' : after();
      },
    },
  );
  return { commit, expected: { item: 'written' }, reads, value };
}

/** A later array descriptor cannot replace the first observed own indexed data. */
function changedSlot(after: () => unknown): Snapshot {
  const descriptors: Record<string, number> = {};
  const value = new Proxy(['written'], {
    getOwnPropertyDescriptor(target, key) {
      const name = String(key);
      const count = (descriptors[name] ?? 0) + 1;
      descriptors[name] = count;
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === '0' && count >= LIMITS.third ? { ...descriptor, value: after() } : descriptor;
    },
  });
  return {
    descriptors,
    expectedDescriptors: { '0': 1, length: 1 },
    expected: ['written'],
    reads: [],
    value,
  };
}

/** A cycle used only as hostile source data, never serialized by the fixture itself. */
function cyclic(): unknown {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  return cycle;
}

/** Invalid own data remains invalid even when a value get disguises it as text. */
function disguised(value: unknown): Snapshot {
  const reads: string[] = [];
  return {
    expected: null,
    reads,
    value: new Proxy(
      { item: value },
      {
        get(target, key, receiver): unknown {
          if (key !== 'item') return Reflect.get(target, key, receiver);
          reads.push('item');
          return 'disguised';
        },
      },
    ),
  };
}

/** A non-JSON function supplied only through the obsolete later source observation. */
function unvalidated(): string {
  return 'unvalidated';
}

function functionValue(): unknown {
  return unvalidated;
}

function lateThrow(): never {
  throw new Error('Late result get');
}

export const snapshotCases: readonly { readonly name: string; readonly make: () => Snapshot }[] = [
  {
    name: 'captures object data before a later function-valued get',
    make: () => changedGet(functionValue),
  },
  {
    name: 'settles committed data before a later cyclic get',
    make: () => changedGet(cyclic, true),
  },
  {
    name: 'settles committed data without a later throwing get',
    make: () => changedGet(lateThrow, true),
  },
  {
    name: 'captures an array slot before a later function descriptor',
    make: () => changedSlot(functionValue),
  },
  {
    name: 'captures an array slot before a later cyclic descriptor',
    make: () => changedSlot(cyclic),
  },
  {
    name: 'refuses captured function data hidden by a value get',
    make: () => disguised(unvalidated),
  },
  { name: 'refuses captured cyclic data hidden by a value get', make: () => disguised(cyclic()) },
  {
    name: 'keeps captured keys before a late unvalidated entry',
    make(): Snapshot {
      let calls = 0;
      const target = { item: 'written', late: () => 'not JSON' };
      return {
        expected: { item: 'written' },
        reads: [],
        value: new Proxy(target, {
          ownKeys() {
            calls += 1;
            return calls >= LIMITS.fourth ? ['item', 'late'] : ['item'];
          },
        }),
      };
    },
  },
];

/** The result is detached JSON before persistence, and a resend reads that exact saved JSON. */
function checkSnapshot(snapshot: Snapshot, actual: unknown): void {
  expect(actual).toStrictEqual(snapshot.expected);
  expect(snapshot.reads).toStrictEqual([]);
  expect(snapshot.descriptors).toStrictEqual(snapshot.expectedDescriptors);
}

/** The actual initial and saved operation receipts agree, including an already committed write. */
export async function checkSnapshotReceipts(
  engine: AuthorityEngine,
  snapshot: Snapshot,
  runs: () => number,
): Promise<void> {
  const receipts = await resultReceipts(engine);
  checkSnapshot(snapshot, receipts.first.result);

  expect(receipts.first.committedRevision).toBe(snapshot.commit === true ? 1 : null);
  expect(receipts.again).toStrictEqual({ ...receipts.first, deduplicated: true });
  expect(JSON.stringify(receipts.first.result)).toBe(JSON.stringify(receipts.again.result));
  expect({ runs: runs(), stats: receipts.stats }).toMatchObject({
    runs: 1,
    stats: { commits: snapshot.commit === true ? 1 : 0, deduplicated: 1, operationRuns: 1 },
  });
}

/** A first required reflection failure retains its original operation failure classification. */
export const reflectionCases = ['ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'] as const;

export function throwingResult(trap: (typeof reflectionCases)[number]): unknown {
  return new Proxy(
    { item: 'written' },
    {
      [trap]() {
        throw new Error('First result reflection');
      },
    },
  );
}

export async function checkReflectionFailure(
  engine: AuthorityEngine,
  commit: boolean,
  runs: () => number,
): Promise<void> {
  const { sessionId } = await engine.login('alice');
  const call = {
    args: [],
    build: BUILD,
    module: 'test/result-slots',
    name: 'answer',
    operationId: 'op-reflection',
  };
  const expected = {
    code: commit ? 'OPERATION_FAILED' : 'OPERATION_REJECTED',
    status: commit ? 500 : 422,
  };

  await expect(engine.operate(sessionId, call)).rejects.toMatchObject(expected);
  await expect(engine.operate(sessionId, call)).rejects.toMatchObject(expected);
  expect({ runs: runs(), stats: await engine.stats() }).toMatchObject({
    runs: 1,
    stats: { commits: commit ? 1 : 0, deduplicated: 1, operationRuns: 1 },
  });
}

/** The existing nesting boundary applies to objects, with primitive leaves at the boundary. */
function nested(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

/** Malformed own entries are built before the assertion callback, without invoking accessors. */
function metadata(kind: string): { readonly value: unknown; readonly reads: () => number } {
  let reads = 0;
  const array = kind.startsWith('array');
  const value = array ? [null] : {};
  let key: string | symbol = array ? '0' : 'item';
  if (kind === 'symbol') key = Symbol('metadata');
  if (kind.endsWith('accessor')) {
    Object.defineProperty(value, key, {
      enumerable: true,
      get() {
        reads += 1;
        return null;
      },
    });
  } else if (kind === 'array named') {
    Object.defineProperty(value, 'extra', { enumerable: true, value: null });
  } else {
    Object.defineProperty(value, key, { enumerable: kind === 'symbol', value: null });
  }

  return { value, reads: () => reads };
}

/** Stable plain values pin the carried JSON contract independently in Node and workerd. */
export function operationSnapshotChecks(): void {
  describe('operation result descriptor snapshots', () => {
    it.each(snapshotCases)('$name', ({ make }) => {
      expect.hasAssertions();

      const snapshot = make();
      checkSnapshot(snapshot, operationResult(snapshot.value));
    });

    it.each([
      { name: 'root undefined', value: undefined, expected: null },
      { name: 'negative zero', value: -0, expected: 0 },
      { name: 'false', value: false, expected: false },
      { name: 'null', value: null, expected: null },
      { name: 'infinity', value: Infinity, expected: null },
      { name: 'bigint', value: 1n, expected: null },
      { name: 'symbol', value: Symbol('not JSON'), expected: null },
      { name: 'date', value: new Date(0), expected: null },
    ])('preserves $name', ({ value, expected }) => {
      expect(operationResult(value)).toBe(expected);
    });

    it('keeps holes, undefined, own proto text and object insertion order', () => {
      const record = { z: -0, a: 2, ['__proto__']: 'own', omitted: undefined };
      const source: unknown[] = [undefined];
      source.length = 2;
      source.push(record);
      const result = operationResult(source);

      expect(result).toStrictEqual([null, null, { z: 0, a: 2, ['__proto__']: 'own' }]);
      expect(JSON.stringify(result)).toBe('[null,null,{"z":0,"a":2,"__proto__":"own"}]');
      expect(Object.hasOwn(source, 1)).toBe(false);
      expect(Object.is(record.z, -0)).toBe(true);
    });

    it('normalizes a null-prototype record without retaining input references', () => {
      const value = Object.assign(Object.create(null) as Record<string, unknown>, {
        z: { n: 0 },
        a: 1,
      });
      const result = operationResult(value);

      expect(result).toStrictEqual({ z: { n: 0 }, a: 1 });
      expect(result).not.toBe(value);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    });

    it('refuses cycles and copies repeated ordinary references independently', () => {
      const repeated = { item: 'written' };

      expect(operationResult(cyclic())).toBeNull();

      const result = operationResult([repeated, repeated]);

      expect(result).toStrictEqual([repeated, repeated]);
      expect((result as unknown[])[0]).not.toBe(repeated);
      expect((result as unknown[])[0]).not.toBe((result as unknown[])[1]);
    });

    it.each([
      'object accessor',
      'array accessor',
      'hidden',
      'symbol',
      'array named',
      'array hidden',
    ])('refuses %s metadata without evaluating getters', (kind) => {
      const { value, reads } = metadata(kind);

      expect(operationResult(value)).toBeNull();
      expect(reads()).toBe(0);
    });

    it('preserves depth 64 and refuses depth 65', () => {
      expect(operationResult(nested(LIMITS.depth))).toStrictEqual(nested(LIMITS.depth));
      expect(operationResult(nested(LIMITS.depth + 1))).toBeNull();
    });

    it('preserves the sparse lower bound before allocating holes', () => {
      const length = Math.floor((MAX_CARRIED_BYTES - 1) / LIMITS.nullSlot);
      const accepted: unknown[] = [];
      accepted.length = length;

      expect(operationResult(accepted)).toHaveLength(length);

      accepted.length += 1;

      expect(operationResult(accepted)).toBeNull();
    });

    it('does not add a total result-size limit', () => {
      const value = 'x'.repeat(MAX_CARRIED_BYTES + 1);

      expect(operationResult(value)).toBe(value);
    });

    it.each(reflectionCases)('propagates the first required %s trap', (trap) => {
      expect(() => operationResult(throwingResult(trap))).toThrow('First result reflection');
    });

    it('preserves a revoked Proxy exception', () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();

      expect(() => operationResult(proxy)).toThrow(TypeError);
    });
  });
}
