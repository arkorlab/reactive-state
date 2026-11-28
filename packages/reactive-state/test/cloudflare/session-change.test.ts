import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Json } from '../../src/program.ts';
import { BUILD } from '../support/program.ts';
import { authority, signIn, valueOf } from './helpers.ts';

/**
 * The session change an operation asks for (`changeSession`), across the object's RPC: answered
 * beside the result, the same on a resend, kept past the object's eviction, and none from an
 * operation that did not succeed.
 */

/** A call of `name` in the test application's `actions/session`, sent with `args`. */
function call(name: string, args: readonly Json[], operationId: string) {
  return {
    args: args.map((json) => ({ json })),
    build: BUILD,
    module: 'actions/session',
    name,
    operationId,
  };
}

describe('the session change an operation asks for, on the object', () => {
  it('crosses the RPC beside the result, on a resend and after the object was evicted', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');
    const sent = call('switchTeam', ['team-2'], 'op-switch');

    const first = valueOf(await stub.operate(alice, sent));
    await evictDurableObject(stub);
    const again = valueOf(await stub.operate(alice, sent));

    expect(first).toStrictEqual({
      committedRevision: null,
      deduplicated: false,
      operationId: 'op-switch',
      result: 'team-2',
      sessionChange: { activeTeam: 'team-2' },
    });
    expect(again).toStrictEqual({ ...first, deduplicated: true });
  });

  it('is answered by an operation that asked for none as it was answered before', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');

    const receipt = valueOf(await stub.operate(alice, call('stayPut', [], 'op-stay')));

    expect(receipt).not.toHaveProperty('sessionChange');
  });

  it.each(['switchThenRefuse', 'switchThenForbid', 'switchThenThrow'])(
    'is none of %s, which did not succeed',
    async (name) => {
      const stub = authority();
      const alice = await signIn(stub, 'alice');

      const answer = await stub.operate(alice, call(name, [], 'op-fails'));

      expect(answer.ok).toBe(false);
      expect(answer).not.toHaveProperty('value');
    },
  );
});
