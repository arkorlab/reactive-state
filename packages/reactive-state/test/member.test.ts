import { describe, expect, it } from 'vitest';

import { member, method, withinSteps } from '../src/authority/steps.ts';

describe('the actual property key of a dynamic site member', () => {
  it('converts an application key once before selecting and invoking its method', () => {
    let conversions = 0;
    const key = {
      [Symbol.toPrimitive]() {
        conversions += 1;
        return conversions === 1 ? 'first' : 'second';
      },
    };
    const receiver = { first: () => 'first', second: () => 'second' };

    const answer = withinSteps(() => method(receiver, member(key) as unknown as 'first')());

    expect(answer).toBe('first');
    expect(conversions).toBe(1);
  });

  it('uses the checked safe key rather than converting it again to constructor', () => {
    let conversions = 0;
    const key = {
      [Symbol.toPrimitive]() {
        conversions += 1;
        return conversions === 1 ? 'join' : 'constructor';
      },
    };

    const answer = withinSteps(() => method([1, 2], member(key) as unknown as 'join')(','));

    expect(answer).toBe('1,2');
    expect(conversions).toBe(1);
  });

  it('refuses a forbidden normalized key after one conversion, retaining that key in the refusal', () => {
    let conversions = 0;
    const key = {
      [Symbol.toPrimitive]() {
        conversions += 1;
        return conversions === 1 ? 'constructor' : 'safe';
      },
    };

    expect(() => member(key)).toThrow('`constructor`');
    expect(conversions).toBe(1);
  });

  it('keeps the symbol primitive of a boxed symbol key', () => {
    const key = Symbol('member');
    const wrapped: unknown = Reflect.construct(Object, [key]);
    const receiver = { [key]: 'symbol value' };

    expect(Reflect.get(receiver, member(wrapped) as PropertyKey)).toBe('symbol value');
  });

  it('preserves ordinary numeric and symbol reads and propagates a throwing key conversion', () => {
    const symbol = Symbol('member');
    const receiver = { 1: 'one', [symbol]: 'symbol' };
    const failure = new Error('conversion failed');
    let conversions = 0;
    const key = {
      [Symbol.toPrimitive]() {
        conversions += 1;
        throw failure;
      },
    };

    expect(Reflect.get(receiver, member(1))).toBe('one');
    expect(Reflect.get(receiver, member(symbol))).toBe('symbol');
    expect(() => member(key)).toThrow(failure);
    expect(conversions).toBe(1);
  });
});
