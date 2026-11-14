import { describe, expect, it } from 'vitest';

import { fieldOperationOf } from '../src/authority/requests.ts';

/**
 * The value a write to a field is sent (`FieldOperation.value`): text, a boolean, or a number JSON
 * carries, which is finite. JSON writes `NaN` and the infinities as `null`, which the Node authority
 * refuses (400) as no value; a Durable Object's RPC, or a host's own call of the engine, carries
 * them as they are, and they are refused alike, before anything is done for the write — not read
 * as the `null` no field's `set` is sent.
 */

const REFUSED = expect.objectContaining({ code: 'INVALID_OPERATION', status: 400 });

function operation(value: unknown): Readonly<Record<string, unknown>> {
  return { binding: 'binding', operationId: 'op:1', updaterId: 'update', value };
}

describe('the value a write to a field is sent', () => {
  it.each([NaN, Infinity, -Infinity])('refuses %s, a number of no JSON', (value) => {
    expect(() => fieldOperationOf(operation(value))).toThrow(REFUSED);
  });

  it('refuses it as it refuses the `null` JSON writes of it, as an HTTP body carries it', () => {
    const body = JSON.stringify(operation(NaN));
    const sent: unknown = JSON.parse(body);

    expect(sent).toHaveProperty('value', null);
    expect(() => fieldOperationOf(sent)).toThrow(REFUSED);
  });

  it.each([0, -1.5, Number.MAX_VALUE, Number.MIN_VALUE, '', 'text', true, false])(
    'keeps %j as it was sent',
    (value) => {
      expect(fieldOperationOf(operation(value)).value).toBe(value);
    },
  );
});
