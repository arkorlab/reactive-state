import { describe, expect, it } from 'vitest';

import { MAX_CARRIED_BYTES } from '../src/authority/json-size.ts';
import { operationResult } from '../src/authority/operation-results.ts';

/**
 * How many arrays deep `doubled` nests, each holding the one below it twice: its JSON writes the
 * array at the bottom 2^21 times, twice as many as a request carries bytes.
 */
const LEVELS = 21;
/** How many zeros `zeros` holds: as many copies of it make as many values as a request has bytes. */
const SIDE = Math.sqrt(MAX_CARRIED_BYTES);

/**
 * `LEVELS` arrays, each holding the one below it twice — no cycle — over one array read through a
 * proxy that counts how often its keys are listed, as a copy lists them each time it copies it.
 */
function doubled(): { readonly value: unknown; readonly listed: () => number } {
  let listed = 0;
  let value: unknown = new Proxy([0], {
    ownKeys(target) {
      listed += 1;
      return Reflect.ownKeys(target);
    },
  });
  for (let level = 0; level < LEVELS; level += 1) {
    value = [value, value];
  }
  return { listed: () => listed, value };
}

function zeros(): number[] {
  return Array.from({ length: SIDE }, () => 0);
}

describe('an operation result that holds one object more than once', () => {
  it('stops copying what it holds again once the copies make more values than a request carries bytes', () => {
    const { listed, value } = doubled();

    const result = operationResult(value);

    // Copied for each place it stands, the array at the bottom would be listed 2^21 times.
    expect(listed()).toBeLessThan(MAX_CARRIED_BYTES);
    expect(result).toBeNull();
  });

  it('holds to the bound the values copies of what was copied before make, not those of the first', () => {
    const shared = zeros();
    // Its first copy aside, `SIDE` copies of `SIDE` zeros each: as many values as the bound.
    const within = operationResult(Array.from({ length: SIDE + 1 }, () => shared));

    expect(within).toStrictEqual(Array.from({ length: SIDE + 1 }, () => shared));
    expect((within as readonly unknown[])[0]).not.toBe((within as readonly unknown[])[1]);
    expect(operationResult(Array.from({ length: SIDE + 2 }, () => shared))).toBeNull();
    // A pin: as many values held once each are copied, whatever their number.
    expect(operationResult(Array.from({ length: SIDE + 2 }, () => zeros()))).toHaveLength(SIDE + 2);
  });
});
