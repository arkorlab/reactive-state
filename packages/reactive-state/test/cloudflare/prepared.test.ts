import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Json } from '../../src/program.ts';
import { BUILD } from '../support/program.ts';
import { authority, inObject, signIn, valueOf } from './helpers.ts';

/**
 * The preparation an operation is sent (`prepared`), across the object's RPC: read by the
 * operation, kept nowhere in the object's storage, and no part of what a resend is answered from.
 */

const MARKER = 'marker-of-the-preparation-7f3a';

/** A call of `name` in the test application's `actions/prepared`. */
function call(name: string, operationId: string, prepared?: unknown) {
  return {
    args: [],
    build: BUILD,
    module: 'actions/prepared',
    name,
    operationId,
    ...(prepared !== undefined && { prepared: prepared as Json }),
  };
}

describe('the preparation of an operation, on the object', () => {
  it('crosses the RPC into the operation', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');

    const receipt = valueOf(
      await stub.operate(alice, call('echo', 'op-echo', { account: 'octocat', ids: [1, 2] })),
    );
    const inTransaction = valueOf(
      await stub.operate(alice, call('readInTransaction', 'op-tx', { inside: true })),
    );
    const none = valueOf(await stub.operate(alice, call('echo', 'op-none')));

    expect(receipt.result).toStrictEqual({ account: 'octocat', ids: [1, 2] });
    expect(inTransaction.result).toStrictEqual({ inside: true });
    expect(none.result).toBeNull();
  });

  it('is in no table of the object, and a resend after eviction is answered from the record', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');
    const sent = call('wasPrepared', 'op-kept', { secret: MARKER });

    const first = valueOf(await stub.operate(alice, sent));
    await evictDurableObject(stub);
    const again = valueOf(
      await stub.operate(alice, call('wasPrepared', 'op-kept', { secret: 'another' })),
    );
    const stored = await inObject(stub, (_instance, state) => {
      const { sql } = state.storage;
      const tables = Array.from(
        sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'"),
        (row) => row['name'] as string,
      );
      return tables.flatMap((name) =>
        Array.from(sql.exec(`SELECT * FROM "${name}"`), (row) => JSON.stringify(row)),
      );
    });

    expect(first.result).toBe(true);
    expect(again).toStrictEqual({ ...first, deduplicated: true });
    expect(stored.some((row) => row.includes(MARKER))).toBe(false);
    expect(stored.some((row) => row.includes('another'))).toBe(false);
  });

  it('is refused (413) past 4096 bytes', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');

    const fits = await stub.operate(alice, call('wasPrepared', 'op-fits', 'x'.repeat(4094)));
    const over = await stub.operate(alice, call('wasPrepared', 'op-over', 'x'.repeat(4095)));

    expect(fits.ok).toBe(true);
    expect(over).toMatchObject({ code: 'TOO_LARGE', ok: false, status: 413 });
  });

  it('is refused (400) where a Date crosses the RPC', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');

    const answer = await stub.operate(alice, call('wasPrepared', 'op-date', new Date(0)));

    expect(answer).toMatchObject({ code: 'INVALID_OPERATION', ok: false, status: 400 });
  });
});
