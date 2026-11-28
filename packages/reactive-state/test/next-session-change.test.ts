import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { redirect } from 'next/navigation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthorityClient } from '../src/client/index.ts';
import type * as Authority from '../src/next/authority.ts';
import { operate, OperationError, type SessionChange } from '../src/next/index.ts';
import type { Json, OperationReceipt, Result } from '../src/program.ts';
import { BUILD } from './support/page.ts';

/**
 * `operate` applies the session change an operation that succeeded asked for (`SessionChange`):
 * awaited, before `refresh`; logged where the application names no applier; thrown where the
 * applier throws; never on a failure.
 */

const hoisted = vi.hoisted(() => {
  return {
    client: {} as Record<string, ReturnType<typeof vi.fn>>,
    refresh: vi.fn<() => void>(),
  };
});

vi.mock(import('next/headers'), () => {
  return {
    cookies: () => Promise.resolve({ get: () => ({ name: 'none', value: '' }) }) as never,
  };
});
vi.mock(import('next/cache'), () => ({ refresh: hoisted.refresh }));
vi.mock(import('../src/next/authority.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal<typeof Authority>()),
    authority: () => hoisted.client as unknown as AuthorityClient,
  };
});

function noop(): void {
  // Nothing is logged to the test's output.
}

const CHANGE: Json = { activeTeam: 'team-2' };

function operated(sessionChange?: Json): Result<OperationReceipt> {
  return {
    ok: true,
    value: {
      committedRevision: 4,
      deduplicated: false,
      operationId: 'op',
      result: 'done',
      ...(sessionChange !== undefined && { sessionChange }),
    },
  };
}

describe('the session change an operation asks for', () => {
  beforeEach(() => {
    hoisted.refresh.mockReset();
    hoisted.client = { operate: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is applied with the change, awaited, before the route renders again', async () => {
    const order: string[] = [];
    const apply = vi.fn<SessionChange>(async () => {
      await Promise.resolve();
      order.push('applied');
    });
    hoisted.refresh.mockImplementation(() => {
      order.push('refreshed');
    });
    hoisted.client['operate']?.mockResolvedValue(operated(CHANGE));

    const result = await operate('actions/session', 'switchTeam', [], {
      build: BUILD,
      sessionChange: apply,
    });

    expect(result).toBe('done');
    expect(apply).toHaveBeenCalledExactlyOnceWith(CHANGE);
    expect(order).toStrictEqual(['applied', 'refreshed']);
  });

  it('is not applied where the operation asked for none', async () => {
    const apply = vi.fn<SessionChange>();
    hoisted.client['operate']?.mockResolvedValue(operated());

    await operate('actions/session', 'stayPut', [], { build: BUILD, sessionChange: apply });

    expect(apply).not.toHaveBeenCalled();
    expect(hoisted.refresh).toHaveBeenCalledTimes(1);
  });

  it('is not applied where the authority refused the operation', async () => {
    const apply = vi.fn<SessionChange>();
    hoisted.client['operate']?.mockResolvedValue({
      code: 'TEAM_FULL',
      message: 'Full.',
      ok: false,
      status: 422,
    });

    await expect(
      operate('actions/session', 'switchTeam', [], { build: BUILD, sessionChange: apply }),
    ).rejects.toBeInstanceOf(OperationError);

    expect(apply).not.toHaveBeenCalled();
    expect(hoisted.refresh).not.toHaveBeenCalled();
  });

  it('is logged and left where the application names no applier, the operation having succeeded', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(noop);
    hoisted.client['operate']?.mockResolvedValue(operated(CHANGE));

    await expect(operate('actions/session', 'switchTeam', [], BUILD)).resolves.toBe('done');

    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain('names no applier');
    expect(hoisted.refresh).toHaveBeenCalledTimes(1);
  });

  it('is the Server Action’s error where the applier throws, logged first, nothing rendered again', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(noop);
    const failure = new Error('The cookie could not be set.');
    hoisted.client['operate']?.mockResolvedValue(operated(CHANGE));

    await expect(
      operate('actions/session', 'switchTeam', [], {
        build: BUILD,
        sessionChange: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(logged).toHaveBeenCalledTimes(1);
    expect(hoisted.refresh).not.toHaveBeenCalled();
  });

  it('lets Next.js’s control flow through: a redirect of the applier is no failure to log', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(noop);
    hoisted.client['operate']?.mockResolvedValue(operated(CHANGE));

    let thrown: unknown;
    try {
      await operate('actions/session', 'switchTeam', [], {
        build: BUILD,
        sessionChange: () => {
          redirect('/x');
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(isRedirectError(thrown)).toBe(true);
    expect(logged).not.toHaveBeenCalled();
    expect(hoisted.refresh).not.toHaveBeenCalled();
  });
});
