import { describe, expect, it } from 'vitest';

import { MAX_CARRIED_BYTES } from '../src/authority/json-size.ts';
import { operationResult } from '../src/authority/operation-results.ts';

/** What JSON writes of a hole, `null`, with the comma after it, as `arrayLength` counts them. */
const HOLE_BYTES = 5;
/** The most holes an array of nothing else may hold, as `arrayLength` bounds them: 209,715. */
const MOST_HOLES = Math.floor((MAX_CARRIED_BYTES - 1) / HOLE_BYTES);
/** How many arrays of `MOST_HOLES` holes fit, all together, as many values as a request has bytes. */
const ARRAYS = Math.floor(MAX_CARRIED_BYTES / MOST_HOLES);
/** The holes left beside `ARRAYS` such arrays to as many as a request carries bytes. */
const REST = MAX_CARRIED_BYTES - ARRAYS * MOST_HOLES;

/** An array `length` long of no element: holes alone, which the application makes of none. */
function holes(length: number): unknown[] {
  const value: unknown[] = [];
  value.length = length;
  return value;
}

describe('an operation result whose arrays hold holes', () => {
  it('holds the holes of all its arrays together to as many values as a request carries bytes', () => {
    const full = Array.from({ length: ARRAYS }, () => holes(MOST_HOLES));

    // As many holes as the bound, all together, and one past it, though no array holds more holes
    // than one may.
    expect(operationResult([...full, holes(REST)])).toHaveLength(ARRAYS + 1);
    expect(operationResult([...full, holes(REST + 1)])).toBeNull();
  });

  it('still copies one array of as many holes as an array may hold', () => {
    expect(operationResult(holes(MOST_HOLES))).toHaveLength(MOST_HOLES);
  });
});
