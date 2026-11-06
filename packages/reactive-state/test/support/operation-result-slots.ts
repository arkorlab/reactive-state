import type { AuthorityEngine } from '../../src/authority/engine.ts';
import type { Application, Stats } from '../../src/authority/model.ts';
import type { OperationReceipt } from '../../src/program.ts';
import { db } from './app/db.ts';
import { application, BUILD } from './program.ts';

/** Both a fresh result and its unchanged application-owned source. */
interface ResultFixture {
  readonly value: Readonly<Record<string, unknown>> | readonly unknown[] | Date;
  readonly expected: unknown;
  readonly calls: string[];
  readonly native: Readonly<{ text?: string | undefined; error?: string }>;
  readonly revision?: number;
  readonly valid?: boolean;
  readonly strict?: boolean;
}

/** An operation result made only after its optional transaction has committed. */
export function resultApplication(
  result: unknown,
  commit: boolean,
): { readonly options: Application; readonly runs: () => number } {
  let runs = 0;
  const answer = async () => {
    runs += 1;
    if (commit) {
      await db.transaction(async () => {
        await db.todos.update('t1', { title: 'Result committed' });
      });
    }
    return result;
  };
  return {
    options: { ...application, operations: { 'test/result-slots': { answer } } },
    runs: () => runs,
  };
}

/** Both the initial response and the persisted response of the same operation. */
export async function resultReceipts(engine: AuthorityEngine): Promise<{
  readonly first: OperationReceipt;
  readonly again: OperationReceipt;
  readonly stats: Stats;
}> {
  const { sessionId } = await engine.login('alice');
  const call = {
    args: [],
    build: BUILD,
    module: 'test/result-slots',
    name: 'answer',
    operationId: 'op-slots',
  };
  const first = await engine.operate(sessionId, call);
  const again = await engine.operate(sessionId, call);
  return { again, first, stats: await engine.stats() };
}

/** Native JSON's inherited dispatch, used only as the explicit baseline witness. */
export function nativeResultText(
  value: unknown,
): Readonly<{ text?: string | undefined; error?: string }> {
  try {
    return { text: JSON.stringify(value) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** A fresh array prototype whose missing first index is application code. */
function sparse(read: () => unknown) {
  class Values extends Array<unknown> {}
  const value = new Values(1);
  Object.defineProperty(Values.prototype, '0', { get: read });
  return value;
}

export const operationResultCases: readonly {
  readonly name: string;
  readonly make: () => ResultFixture;
}[] = [
  {
    name: 'normalizes a hole without reading an inherited value',
    make(): ResultFixture {
      const calls: string[] = [];
      const value = sparse(() => {
        calls.push('index');
        return 'phantom';
      });
      return { calls, expected: [null], strict: false, native: { text: '["phantom"]' }, value };
    },
  },
  {
    name: 'settles a committed result without a throwing inherited getter',
    make(): ResultFixture {
      const calls: string[] = [];
      const value = sparse(() => {
        calls.push('index');
        throw new Error('Inherited operation result');
      });
      return {
        calls,
        revision: 1,
        expected: [null],
        strict: false,
        native: { error: 'Inherited operation result' },
        value,
      };
    },
  },
  {
    name: 'normalizes nested holes while preserving repeated own data',
    make(): ResultFixture {
      const calls: string[] = [];
      const value = sparse(() => {
        calls.push('index');
        return 'nested phantom';
      });
      return {
        calls,
        expected: { nested: [[null], [null]] },
        native: { text: '{"nested":[["nested phantom"],["nested phantom"]]}' },
        strict: false,
        value: { nested: [value, value] },
      };
    },
  },
  {
    name: 'ignores an inherited array toJSON hook',
    make(): ResultFixture {
      const calls: string[] = [];
      class Values extends Array<string> {}
      const value = new Values('stored');
      Object.defineProperty(Values.prototype, 'toJSON', {
        value() {
          calls.push('toJSON');
          return ['phantom'];
        },
      });
      return { calls, expected: ['stored'], native: { text: '["phantom"]' }, value };
    },
  },
  {
    name: 'keeps own entries ahead of prototype indices and traversal hooks',
    make(): ResultFixture {
      const calls: string[] = [];
      const value = sparse(() => {
        calls.push('index');
        throw new Error('Own entry shadows inherited index');
      });
      Object.defineProperty(value, '0', { enumerable: true, value: { zero: -0 } });
      const prototype = Object.getPrototypeOf(value) as typeof Array.prototype;
      const descriptor = {
        get() {
          calls.push('traversal');
          throw new Error('Traversal is application code');
        },
      };
      Object.defineProperties(prototype, { entries: descriptor, [Symbol.iterator]: descriptor });
      return { calls, expected: [{ zero: 0 }], native: { text: '[{"zero":0}]' }, value };
    },
  },
  {
    name: 'copies undefined slots and omits object undefined while keeping own proto data',
    make: (): ResultFixture => {
      return {
        calls: [],
        expected: [null, { ['__proto__']: 'own', value: 0 }],
        native: { text: '[null,{"__proto__":"own","value":0}]' },
        strict: false,
        value: [undefined, { ['__proto__']: 'own', omitted: undefined, value: -0 }],
      };
    },
  },
  {
    name: 'returns null for an own indexed accessor without invoking it',
    make(): ResultFixture {
      const calls: string[] = [];
      const value: unknown[] = [];
      Object.defineProperty(value, '0', {
        enumerable: true,
        get() {
          calls.push('accessor');
          return 'computed';
        },
      });
      return { calls, expected: null, native: { text: '["computed"]' }, valid: false, value };
    },
  },
  {
    name: 'retains malformed result behavior',
    make: (): ResultFixture => {
      return {
        calls: [],
        expected: null,
        native: { text: '"1970-01-01T00:00:00.000Z"' },
        valid: false,
        value: new Date(0),
      };
    },
  },
  {
    name: 'keeps object key order and nested own proto data in both receipts',
    make: (): ResultFixture => {
      const value = { z: 1, a: 2, nested: [{ y: 1, b: 2, ['__proto__']: 'own' }] };
      return {
        calls: [],
        expected: value,
        native: { text: '{"z":1,"a":2,"nested":[{"y":1,"b":2,"__proto__":"own"}]}' },
        value,
      };
    },
  },
];
