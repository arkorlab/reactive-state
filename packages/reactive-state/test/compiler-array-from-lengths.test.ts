import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The array-like conversion is evaluated before the authority receives a trailing JSON value. */
const fixture = stateFixture('array-from-lengths', 'ArrayFromLengths');

/** Array.from converts an array-like length only when it does not select an iterator. */
describe('written Array.from length conversions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Array.from({length:1n} as never)',
    'Array.from({length:Symbol("length")} as never)',
    '(()=>{const size=1n;return Array.from({length:size} as never);})()',
    '(()=>{const size=Symbol.iterator;return Array.from({length:size} as never);})()',
    'Array.from({length:BigInt(1)} as never)',
    'Array.from({length:0,length:1n} as never)',
  ])('refuses a length that cannot become a number: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Array.from({length:0})',
    'Array.from({length:"1"} as never)',
    'Array.from({length:false} as never)',
    'Array.from({length:1n,...{},length:0} as never)',
    'Array.from({length:1n,*[Symbol.iterator](){}})',
    'Array.from({get length(){return 0;}})',
    'Array.from({[first]:1n} as never)',
    'Array.from({length:first} as never)',
    '(()=>{const source={length:1n as unknown};return Array.from(source as never,(source.length=0,undefined));})()',
    '(()=>{try{Array.from({length:1n} as never);}catch{}return 0;})()',
    '(()=>Array.from({length:1n} as never))',
    'false&&Array.from({length:1n} as never)',
  ])('keeps valid, iterator, unproven, repaired and unexecuted sources: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
