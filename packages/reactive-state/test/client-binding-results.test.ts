import { describe, expect, it, vi } from 'vitest';

import { type AuthorityClient, bindingClient } from '../src/client/index.ts';
import type { Result } from '../src/program.ts';

/** What the binding client answers for an RPC that answered something other than a result. */
const MALFORMED = {
  code: 'AUTHORITY_UNAVAILABLE',
  message: 'The authority answered something other than a result.',
  ok: false,
  status: 503,
};

/** A client of one object, whose `logout` answers `answer`. */
function answering(answer: unknown): AuthorityClient {
  const logout = vi.fn<AuthorityClient['logout']>().mockResolvedValue(answer as Result<null>);
  return bindingClient({ getByName: () => ({ logout }) as unknown as AuthorityClient });
}

describe('what the binding client takes for a result', () => {
  it('takes no success that carries no value', async () => {
    await expect(answering({ ok: true }).logout('s1')).resolves.toStrictEqual(MALFORMED);
  });

  it('takes a success of any value it carries, `null` and `undefined` among them', async () => {
    await expect(answering({ ok: true, value: null }).logout('s1')).resolves.toStrictEqual({
      ok: true,
      value: null,
    });
    await expect(answering({ ok: true, value: undefined }).logout('s1')).resolves.toStrictEqual({
      ok: true,
      value: undefined,
    });
  });
});
