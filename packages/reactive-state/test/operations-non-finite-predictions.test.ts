import { describe, expect, it } from 'vitest';

import type { Frame, Value } from '../src/program.ts';
import { displayValue, type PendingOperation, type Predictor } from '../src/runtime/operations.ts';

/** The field the suite writes, and the session that writes it. */
const ESTIMATE = 'todos:t1:estimate';
const SESSION = 'session:alice';

/** A frame at revision 1 that holds `2` of the estimate, and reflects no operation. */
const FIRST: Frame = {
  buildId: 'build:1',
  digest: 'digest:root:p1:1',
  fields: { [ESTIMATE]: 2 },
  operations: [],
  revision: 1,
  rootKey: 'root:p1',
  subscription: 'subscription:root:p1:1',
  view: {},
};

/** An `apply` of the estimate the session made, `id`, which `predict` predicts. */
function applied(id: string, predict: Predictor): PendingOperation {
  return { committedRevision: null, field: ESTIMATE, id, kind: 'apply', predict, session: SESSION };
}

/** What the page shows of the estimate with `predictions` made in turn, no frame reflecting one. */
function shown(...predictions: readonly Predictor[]): Value | undefined {
  const pending = predictions.map((predict, index) => applied(`op-${String(index + 1)}`, predict));
  return displayValue(FIRST, SESSION, pending, ESTIMATE);
}

/**
 * Arithmetic of a page's value answers a number that is not finite without throwing — `1 / 0`,
 * `Math.sqrt(-1)` — which no field holds, and the authority refuses to write: the page shows the
 * value as it was, as of a prediction that throws, and goes on from it.
 */
describe('a prediction of a number that is not finite', () => {
  it.each([
    ['NaN', (value: Value) => Math.sqrt(1 - Number(value))],
    ['Infinity', (value: Value) => 1 / (Number(value) - 2)],
    ['-Infinity', (value: Value) => -1 / (Number(value) - 2)],
  ])('leaves the value as it was where it answers %s', (_answer, predict) => {
    expect(shown(predict)).toBe(2);
  });

  it('hands the next prediction the value as it was', () => {
    expect(
      shown(
        (value) => Number(value) / 0,
        (value) => Number(value) + 1,
      ),
    ).toBe(3);
  });

  // A pin, which passes before the change as well: a finite answer is shown as it is.
  it('shows a finite answer as it is', () => {
    expect(shown((value) => Number(value) / 4)).toBe(0.5);
  });
});
