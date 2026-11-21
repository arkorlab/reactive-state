import { afterEach, describe, expect, it, vi } from 'vitest';

import { authority, sessionOf } from '../src/next/authority.ts';
import { INTERNAL_HEADER, type Result, SESSION_COOKIE } from '../src/program.ts';

/**
 * Which authority the application's server reaches: the Durable Object a deployment's binding
 * names, the local process the environment names, or none.
 */

const RESOURCES = Symbol.for('upwind.resources');

describe("the application's server", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe('the authority', () => {
    it('is none where nothing names one, and answers every call with why', async () => {
      vi.stubEnv('REACTIVE_ENGINE_URL', '');
      vi.stubEnv('REACTIVE_ENGINE_TOKEN', '');

      await expect(authority().login('alice')).resolves.toMatchObject({
        code: 'AUTHORITY_NOT_CONFIGURED',
        ok: false,
        status: 503,
      });
      await expect(
        authority().render(null, { build: 'b', component: 'components/project', props: {} }),
      ).resolves.toMatchObject({ code: 'AUTHORITY_NOT_CONFIGURED' });
    });

    it('is the Durable Object the deployment’s binding names', async () => {
      const login = vi.fn((): Promise<Result<unknown>> =>
        Promise.resolve({ ok: true, value: { sessionId: 's', userId: 'alice' } }),
      );
      vi.stubGlobal(RESOURCES, {
        resources: {
          REACTIVE_AUTHORITY: {
            binding: { getByName: () => ({ login }) },
            type: 'durable_object_namespace',
          },
        },
        version: 1,
      });

      await expect(authority().login('alice')).resolves.toMatchObject({ ok: true });
      expect(login).toHaveBeenCalledExactlyOnceWith('alice');
    });

    it('is the local process the environment names, reached with its token', async () => {
      vi.stubEnv('REACTIVE_ENGINE_URL', 'http://127.0.0.1:4100');
      vi.stubEnv('REACTIVE_ENGINE_TOKEN', 'internal-token');
      const fetched = vi.fn<typeof fetch>(() =>
        Promise.resolve(Response.json({ sessionId: 's', userId: 'alice' })),
      );
      vi.stubGlobal('fetch', fetched);

      await authority().login('alice');

      const [url, init] = fetched.mock.calls[0] ?? [];

      expect(url instanceof Request ? url.url : String(url)).toMatch(
        /^http:\/\/127\.0\.0\.1:4100\//u,
      );
      expect(new Headers(init?.headers).get(INTERNAL_HEADER)).toBe('internal-token');
    });
  });

  describe('a route’s session', () => {
    it('is the one its cookie names, among the others', () => {
      const named = new Request('http://localhost/', {
        headers: { cookie: `theme=dark; ${SESSION_COOKIE}=session-a; other=1` },
      });

      expect(sessionOf(named)).toBe('session-a');
      expect(sessionOf(new Request('http://localhost/'))).toBeNull();
      expect(
        sessionOf(new Request('http://localhost/', { headers: { cookie: `${SESSION_COOKIE}=` } })),
      ).toBeNull();
    });
  });
});
