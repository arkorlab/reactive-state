import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthorityClient } from '../src/client/index.ts';
import type * as Authority from '../src/next/authority.ts';
import { type Elements, operate, updateField, viewRoot } from '../src/next/index.ts';
import type { FieldReceipt, OperationReceipt, Result } from '../src/program.ts';
import { BUILD } from './support/page.ts';

/**
 * What a Server Action is sent is copied as JSON before the authority is called. React can hand
 * back one object reachable through many paths, which a copy writes at each: the copy is bounded
 * by what the authority would accept of the text anyway, and refuses past it as it goes.
 */

const hoisted = vi.hoisted(() => ({ client: {} as Record<string, ReturnType<typeof vi.fn>> }));

vi.mock(import('next/headers'), () => {
  const jar = Promise.resolve({ get: () => null }) as never;
  return { cookies: () => jar };
});
vi.mock(import('next/cache'), () => ({ refresh: vi.fn<() => void>() }));
vi.mock(import('../src/next/authority.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal<typeof Authority>()),
    authority: () => hoisted.client as unknown as AuthorityClient,
  };
});

const ELEMENTS: Elements = { actions: {}, build: BUILD, clients: {}, modules: {} };
const LEVELS = 24;
const FAST_MS = 200;
const HEAP_BYTES = 64 * 1024 * 1024;

/** An object of 24 levels, each holding the one below twice: `2 ** 24` values as JSON. */
function shared(): Record<string, unknown> {
  let level: Record<string, unknown> = {};
  for (let depth = 0; depth < LEVELS; depth += 1) {
    level = { a: level, b: level };
  }
  return level;
}

/** An object of `count` entries. */
function entries(count: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, 0]));
}

/** What `running` took, in milliseconds and in heap. */
async function measured<T>(
  running: () => Promise<T>,
): Promise<{ heap: number; ms: number; value: T }> {
  const heap = process.memoryUsage().heapUsed;
  const start = performance.now();
  const value = await running();
  return { heap: process.memoryUsage().heapUsed - heap, ms: performance.now() - start, value };
}

/** What `running` threw, or `null`. */
async function thrown(running: () => Promise<unknown>): Promise<unknown> {
  try {
    await running();
  } catch (error) {
    return error;
  }
  return null;
}

function receipt(): Result<OperationReceipt> {
  return {
    ok: true,
    value: { committedRevision: 1, deduplicated: false, operationId: 'op', result: 'done' },
  };
}

describe('a Server Action’s input, copied as JSON', () => {
  beforeEach(() => {
    hoisted.client = { operate: vi.fn(), update: vi.fn(), view: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('an operation’s arguments', () => {
    it('refuses a deeply shared object quickly, naming the argument', async () => {
      const { heap, ms, value } = await measured(() =>
        thrown(() => operate('actions/todos', 'create', ['p1', shared()], BUILD)),
      );

      expect(value).toBeInstanceOf(TypeError);
      // Each object of it writes eleven characters of JSON and is one value: the JSON one request
      // carries is passed before the count of values is, a third of the way to it.
      expect((value as TypeError).message).toMatch(
        /^Argument 2\.\S* is past the 1048576 characters of JSON one request carries\.$/u,
      );
      expect(hoisted.client['operate']).not.toHaveBeenCalled();
      expect(ms).toBeLessThan(FAST_MS);
      expect(heap).toBeLessThan(HEAP_BYTES);
    });

    it('takes a list just under the budget, in one argument', async () => {
      hoisted.client['operate']?.mockResolvedValue(receipt());

      await expect(
        operate('actions/todos', 'create', [Array.from({ length: 262_143 }, () => 0)], BUILD),
      ).resolves.toBe('done');
    });

    it('refuses a list over the budget spread across several arguments, as one budget', async () => {
      const part = Array.from({ length: 70_000 }, () => 0);

      const error = await thrown(() =>
        operate('actions/todos', 'create', [part, part, part, part], BUILD),
      );

      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toContain('Argument 4');
      expect((error as TypeError).message).toContain('262144 values');
      expect(hoisted.client['operate']).not.toHaveBeenCalled();
    });
  });

  describe('a view', () => {
    it('is refused quickly where its object is deeply shared', async () => {
      const { heap, ms, value } = await measured(() =>
        viewRoot({ subscription: 's', view: shared() }, ELEMENTS),
      );

      expect(value).toMatchObject({ code: 'INVALID_VIEW', ok: false, status: 400 });
      expect(hoisted.client['view']).not.toHaveBeenCalled();
      expect(ms).toBeLessThan(FAST_MS);
      expect(heap).toBeLessThan(HEAP_BYTES);
    });
  });

  describe('an update’s captures', () => {
    it('are refused quickly where their object is deeply shared', async () => {
      const { heap, ms, value } = await measured(() => {
        return updateField({
          binding: 'b',
          captures: shared(),
          operationId: 'op',
          updaterId: 'u',
        });
      });

      expect(value).toMatchObject({ code: 'INVALID_OPERATION', ok: false, status: 400 });
      expect(hoisted.client['update']).not.toHaveBeenCalled();
      expect(ms).toBeLessThan(FAST_MS);
      expect(heap).toBeLessThan(HEAP_BYTES);
    });

    it('are taken at the budget, and refused one value past it', async () => {
      hoisted.client['update']?.mockResolvedValue({
        ok: true,
        value: { committedRevision: 2, deduplicated: false, operationId: 'op' },
      } satisfies Result<FieldReceipt>);
      const at = { binding: 'b', operationId: 'op', updaterId: 'u' };

      await expect(updateField({ ...at, captures: entries(4095) })).resolves.toMatchObject({
        ok: true,
      });
      await expect(updateField({ ...at, captures: entries(4096) })).resolves.toMatchObject({
        code: 'INVALID_OPERATION',
        ok: false,
      });
    });
  });
});
