import { describe, expect, it } from 'vitest';

import { counted, withinSteps } from '../src/authority/steps.ts';
import { VIEW_LIMITS } from '../src/program.ts';
import { proxyMeasurements } from './support/proxy-budget.ts';

/** Identical boundary witnesses run under Node and actual workerd. */
describe('proxy intermediates at the measurement boundary', () => {
  it.each(proxyMeasurements())('refuses $name without inspecting unused traps', ({ make }) => {
    const { value, calls } = make();

    expect(() => withinSteps(() => counted(value))).toThrow('Proxy intermediate');
    expect(calls).toStrictEqual([]);
  });

  it('does not inspect values outside a running dynamic site', () => {
    const value = Proxy.revocable({}, {});
    value.revoke();

    expect(counted(value.proxy)).toBe(value.proxy);
  });

  it('retains the full ordinary and nested string budget', () => {
    expect(() => withinSteps(() => counted('x'.repeat(VIEW_LIMITS.steps)))).toThrow(RangeError);
    expect(() => withinSteps(() => counted({ nested: ['x'.repeat(VIEW_LIMITS.steps)] }))).toThrow(
      RangeError,
    );
  });

  it('preserves an ordinary intermediate by identity', () => {
    const value = { value: 'ok' };

    expect(withinSteps(() => counted(value))).toBe(value);
  });
});
