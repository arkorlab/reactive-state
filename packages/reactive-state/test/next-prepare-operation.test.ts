import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { redirect } from 'next/navigation';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { AuthorityClient } from '../src/client/index.ts';
import type * as Authority from '../src/next/authority.ts';
import { operate, type OperationPreparation } from '../src/next/index.ts';
import {
  type OperationCall,
  type OperationReceipt,
  type Result,
  PREPARED_LIMIT,
} from '../src/program.ts';
import { BUILD } from './support/page.ts';

/**
 * `operate` runs the application's preparation of an operation (`OperationPreparation`) once, for a
 * signed-in session, before the call goes out: its JSON answer is the call's `prepared`.
 */

const hoisted = vi.hoisted(
  (): {
    client: Record<string, ReturnType<typeof vi.fn>>;
    refresh: ReturnType<typeof vi.fn<() => void>>;
    session: string | null;
  } => ({ client: {}, refresh: vi.fn<() => void>(), session: 'session-1' }),
);

vi.mock(import('next/cache'), () => ({ refresh: hoisted.refresh }));
vi.mock(import('../src/next/authority.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal<typeof Authority>()),
    authority: () => hoisted.client as unknown as AuthorityClient,
    requestSession: () => Promise.resolve(hoisted.session),
  };
});

function noop(): void {
  // Nothing is logged to the test's output.
}

const OK: Result<OperationReceipt> = {
  ok: true,
  value: { committedRevision: 4, deduplicated: false, operationId: 'op', result: 'done' },
};
const UNAVAILABLE = { code: 'UNAVAILABLE', message: 'Down.', ok: false, status: 503 } as const;

/** The calls the authority was sent, in order. */
function sent(): readonly OperationCall[] {
  return (hoisted.client['operate']?.mock.calls ?? []).map((args) => args[1] as OperationCall);
}

/** Runs `actions/people#invite` with `args`, prepared by `prepareOperation`. */
async function run(
  prepareOperation: OperationPreparation | undefined,
  args: readonly unknown[] = [],
): Promise<unknown> {
  return operate('actions/people', 'invite', args, {
    build: BUILD,
    ...(prepareOperation !== undefined && { prepareOperation }),
  });
}

describe('the preparation of an operation', () => {
  beforeEach(() => {
    hoisted.refresh.mockReset();
    hoisted.session = 'session-1';
    hoisted.client = { operate: vi.fn().mockResolvedValue(OK) };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is handed the module, the name and copies of the arguments, and its answer is sent', async () => {
    const form = new FormData();
    form.append('login', 'octocat');
    const json = { nested: { n: 1 } };
    const seen: unknown[] = [];
    const prepare = vi.fn<OperationPreparation>((operation) => {
      seen.push(...operation.args);
      // What a hook does to its copies changes nothing that is sent.
      (operation.args[1] as { nested: { n: number } }).nested.n = 99;

      expect(hoisted.client['operate']).not.toHaveBeenCalled();

      return { accountId: 42 };
    });

    await run(prepare, [form, json]);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({ module: 'actions/people', name: 'invite' });
    expect(seen[0]).toBeInstanceOf(FormData);
    expect([...(seen[0] as FormData)]).toStrictEqual([['login', 'octocat']]);
    expect(json.nested.n).toBe(1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({
      args: [{ form: [['login', 'octocat']] }, { json: { nested: { n: 1 } } }],
      prepared: { accountId: 42 },
    });
  });

  it('renders the route again once the prepared operation ran', async () => {
    await run(() => ({ a: 1 }));

    expect(hoisted.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps null as an answer', async () => {
    await run(() => null);

    expect(sent()[0]).toHaveProperty('prepared', null);
  });

  it('sends no field where it answers undefined', async () => {
    await run(vi.fn<OperationPreparation>());

    expect(sent()[0]).not.toHaveProperty('prepared');
  });

  it('sends no field where the application names none', async () => {
    await run(undefined);

    expect(sent()[0]).not.toHaveProperty('prepared');
  });

  it('runs once across the resends of a call whose outcome is unknown', async () => {
    vi.useFakeTimers();
    try {
      hoisted.client['operate']
        ?.mockResolvedValueOnce(UNAVAILABLE)
        .mockResolvedValueOnce(UNAVAILABLE)
        .mockResolvedValueOnce(OK);
      const prepare = vi.fn<OperationPreparation>(() => ({ once: true }));

      const running = run(prepare);
      await vi.runAllTimersAsync();
      await running;

      expect(prepare).toHaveBeenCalledTimes(1);
      expect(sent()).toHaveLength(3);
      expect(sent().map((call) => call.prepared)).toStrictEqual([
        { once: true },
        { once: true },
        { once: true },
      ]);
      expect(new Set(sent().map((call) => call.operationId)).size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not run for a request of no session', async () => {
    hoisted.session = null;
    const prepare = vi.fn<OperationPreparation>(() => ({ a: 1 }));

    await run(prepare);

    expect(prepare).not.toHaveBeenCalled();
    expect(sent()[0]).not.toHaveProperty('prepared');
  });

  it('is logged and thrown where it throws, with nothing sent and no route rendered again', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(noop);
    const failure = new Error('The token was refused.');

    await expect(
      run(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(hoisted.client['operate']).not.toHaveBeenCalled();
    expect(hoisted.refresh).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain('actions/people#invite');
  });

  it('lets a redirect of the hook through unlogged, with nothing sent', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(noop);

    let thrown: unknown;
    try {
      await run(() => {
        redirect('/sign-in');
      });
    } catch (error) {
      thrown = error;
    }

    expect(isRedirectError(thrown)).toBe(true);
    expect(logged).not.toHaveBeenCalled();
    expect(hoisted.client['operate']).not.toHaveBeenCalled();
    expect(hoisted.refresh).not.toHaveBeenCalled();
  });

  it.each([
    ['a date', () => new Date(0) as never],
    ['a function', () => (() => 1) as never],
    ['NaN', () => NaN as never],
    ['a string of 4097 bytes', () => 'x'.repeat(PREPARED_LIMIT - 1)],
  ])('is a TypeError where the answer is no JSON of 4 KiB: %s', async (_name, answer) => {
    await expect(run(answer)).rejects.toBeInstanceOf(TypeError);

    expect(hoisted.client['operate']).not.toHaveBeenCalled();
    expect(hoisted.refresh).not.toHaveBeenCalled();
  });

  it('takes an answer of exactly 4096 bytes', async () => {
    const answer = 'x'.repeat(PREPARED_LIMIT - 2);

    await run(() => answer);

    expect(sent()[0]).toHaveProperty('prepared', answer);
  });

  it('counts the bytes of UTF-8, not the characters', async () => {
    const wide = 'あ'.repeat(1366);

    await expect(run(() => wide)).rejects.toThrow('4096 at most');

    expect(hoisted.client['operate']).not.toHaveBeenCalled();
  });

  it('is not run where an argument is refused first: a file', async () => {
    const prepare = vi.fn<OperationPreparation>(() => ({ a: 1 }));
    const form = new FormData();
    form.append('upload', new File(['x'], 'x.txt'));

    await expect(run(prepare, [form])).rejects.toThrow('holds a file');

    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('the type of the preparation', () => {
  it('accepts an object typed by an interface, which has no index signature', async () => {
    interface Account {
      readonly id: number;
      readonly login: string;
    }
    const account: Account = { id: 1, login: 'octocat' };
    const prepare: OperationPreparation = () => Promise.resolve({ account });

    expectTypeOf(prepare).returns.toEqualTypeOf<unknown>();

    await run(prepare);

    expect(sent()[0]?.prepared).toStrictEqual({ account: { id: 1, login: 'octocat' } });
  });

  it('still refuses what is not JSON, at run time', async () => {
    await expect(run(() => ({ when: new Date() }))).rejects.toThrow(TypeError);

    expect(hoisted.client['operate']).not.toHaveBeenCalled();
  });
});
