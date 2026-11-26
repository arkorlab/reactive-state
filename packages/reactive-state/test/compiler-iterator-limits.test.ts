import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

const fixture = stateFixture('iterator-limits', 'IteratorLimits');

/** Iterator helpers validate their first limit before returning a deferred helper object. */
describe('written native Iterator helper limits', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Iterator.from([1]).take(-1)',
    'Iterator.from([1]).drop(-2.5)',
    'Iterator.from([1]).take(NaN)',
    'Iterator.from([1]).drop(undefined)',
    'Iterator.from([1]).take()',
    "Iterator.from([1]).drop('bad' as never)",
    'Iterator.from([1]).take(1n as never)',
    'Iterator.from([1]).drop(Symbol.iterator as never)',
    "globalThis.Iterator.from('').drop(-Infinity)",
    '(()=>{const I=Iterator;return I.from([1]).take(-1);})()',
    '(()=>{const limit=-1n;return Iterator.from([1]).drop(limit as never);})()',
    '(()=>{const empty=undefined;return Iterator.from([1]).drop(empty as never);})()',
  ])('refuses an invalid source-proven helper limit: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('which no JSON holds'),
    ]);
  });

  it.each([
    'Iterator.from([1]).take(Infinity)',
    'Iterator.from([1]).drop(Infinity)',
    'Iterator.from([1]).take(-0.5)',
    'Iterator.from([1]).drop(-0.5)',
    'Iterator.from([1]).take(null as never)',
    'Iterator.from([1]).drop(true as never)',
    "Iterator.from([1]).take('2' as never)",
    'Iterator.from([1]).drop(0)',
    '({take(_limit:unknown){return first;}}).take(-1)',
    'Iterator.from([1]).take(Number(first))',
    '(()=>{const saved=globalThis.Iterator;try{globalThis.Iterator={from(){return{take(){return first;}};}} as never;return Iterator.from([1]).take(-1);}finally{globalThis.Iterator=saved;}})()',
    '(()=>{const saved=Iterator.prototype.take;try{return Iterator.from([(Iterator.prototype.take=(()=>first) as never,1)]).take(-1);}finally{Iterator.prototype.take=saved;}})()',
  ])('keeps valid limits, application methods and uncertain evaluation: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
