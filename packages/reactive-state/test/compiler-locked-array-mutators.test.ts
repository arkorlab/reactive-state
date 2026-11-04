import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The prop branch discards the replacement result before the authority starts its JSON state. */
const fixture = stateFixture('locked-array-mutators', 'LockedArrayMutators');

/** Array mutators still perform strict internal writes on locked source arrays. */
describe('written locked array mutations', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(Object.freeze([]) as never[]).push(1 as never)',
    'Object.freeze([]).pop()',
    'Object.freeze([]).shift()',
    'Object.freeze([]).unshift()',
    'Object.freeze([]).splice()',
    'Object.freeze([1]).fill(0)',
    'Object.freeze([1,2]).reverse()',
    'Object.freeze([2,1]).sort()',
    'Object.seal([]).push(1 as never)',
    'Object.preventExtensions([]).unshift(1 as never)',
    'Object.seal([1]).pop()',
    'Object.seal([1,2]).shift()',
    'Object.seal([1]).splice(0,1)',
    'Object.seal([,]).fill(0)',
    'Object.seal([1,,]).reverse()',
    'Object.preventExtensions([,1]).sort()',
    '(()=>{const items=Object.freeze([1]);return items.push(first as never);})()',
  ])('refuses a necessarily failing array mutation: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Object.freeze([]).fill(0 as never)',
    'Object.freeze([]).reverse()',
    'Object.freeze([1]).reverse()',
    'Object.freeze([1]).sort()',
    'Object.freeze([,,]).reverse()',
    'Object.freeze([,,]).sort()',
    'Object.freeze([1]).fill(0,1,1)',
    'Object.seal([]).pop()',
    'Object.seal([]).shift()',
    'Object.seal([]).push()',
    'Object.seal([1]).fill(0)',
    'Object.seal([1,2]).reverse()',
    'Object.seal([2,1]).sort()',
    'Object.seal([1]).splice(0,1,2)',
    'Object.preventExtensions([1]).pop()',
    'Object.preventExtensions([1,2]).shift()',
    '(first as unknown as number[]).push(1)',
    '(()=>{try{Object.freeze([]).push(1 as never);}catch{}return first;})()',
    '(function*(){return Object.freeze([]).push(1 as never);})()',
    'false&&Object.freeze([]).push(1 as never)',
    'Object.freeze([1]).fill(0,{valueOf(){return 1;}} as never)',
    'Object.freeze(Object.defineProperty([],"push",{value(){return first;}})).push(1)',
    '(()=>{const items=Object.preventExtensions([,1]);items.length=0;return items.sort();})()',
    '(()=>{const original=Array.prototype.push;try{Array.prototype.push=(()=>0) as never;return Object.freeze([]).push(1 as never);}finally{Array.prototype.push=original;}})()',
  ])('keeps no-op, writable, unknown, changed and handled arrays: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
