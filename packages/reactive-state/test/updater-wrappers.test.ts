import { describe, expect, it } from 'vitest';

import { writesOf } from './support/component-writes.ts';

/**
 * An update a setter is given is the function written where it is called, or a constant function
 * given by name, within what only types change of it: parentheses, `as`, `satisfies`, `!`. The
 * authority is sent none of it: a call registered as the update it is is sent its id, and a call
 * read as a value is sent the function, which no persistent setter takes.
 */

function click(call: string): string {
  return ['<button type="button" onClick={() => ', call, '}>{count}</button>'].join('');
}

describe('an update a setter is given behind a cast', () => {
  it.each([
    {
      id: 'as',
      call: 'setCount(((current: number) => current + 1) as (current: number) => number)',
    },
    {
      id: 'satisfies',
      call: 'setCount(((current: number) => current + 1) satisfies (current: number) => number)',
    },
    { id: 'non-null', call: 'setCount(((current: number) => current + 1)!)' },
    {
      id: 'as unknown as',
      call: 'setCount(((current: number) => current + 1) as unknown as never)',
    },
    {
      id: 'as inside a parenthesis',
      call: 'setCount((((current: number) => current + 1) as never))',
    },
    {
      id: 'a function expression',
      call: 'setCount((function (current: number) { return current + 1; }) as never)',
    },
  ])('is registered as the update it is: $id', ({ call }) => {
    expect(writesOf(click(call))).toStrictEqual({ applies: 1, reason: undefined, sets: 0 });
  });

  it('registers a constant function of the owner that is cast where it is given', () => {
    expect(
      writesOf(
        click('setCount(inc as (current: number) => number)'),
        '  const inc = (current: number): number => current + 1;',
      ),
    ).toStrictEqual({ applies: 1, reason: undefined, sets: 0 });
  });

  it('keeps registering a constant function given by name', () => {
    expect(
      writesOf(click('setCount(inc)'), '  const inc = (current: number): number => current + 1;'),
    ).toStrictEqual({ applies: 1, reason: undefined, sets: 0 });
  });

  it.each([
    { id: 'written bare', call: 'setCount((current) => current + 1)' },
    { id: 'parenthesised', call: 'setCount(((current) => current + 1))' },
  ])('keeps registering what it did: $id', ({ call }) => {
    expect(writesOf(click(call))).toStrictEqual({ applies: 1, reason: undefined, sets: 0 });
  });

  it.each([
    { id: 'a number cast', call: 'setCount(first as number)' },
    { id: 'a prop asserted', call: 'setCount(first!)' },
    { id: 'a prop that satisfies a type', call: 'setCount(first satisfies number)' },
    { id: 'a value of the page', call: 'setCount(count + 1)' },
  ])('stays the value the page sends where it is no function: $id', ({ call }) => {
    expect(writesOf(click(call))).toStrictEqual({ applies: 0, reason: undefined, sets: 1 });
  });

  it('reads a constant that holds a cast function as it did, a value', () => {
    expect(
      writesOf(
        click('setCount(inc)'),
        '  const inc = ((current: number): number => current + 1) as (current: number) => number;',
      ),
    ).toStrictEqual({ applies: 0, reason: undefined, sets: 1 });
  });
});
