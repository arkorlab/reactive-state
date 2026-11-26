import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A native typed operation runs before its result is discarded by the authority initializer. */
const fixture = stateFixture('typed-arraylike-elements', 'TypedArrayLikeElements');

/** Quiet own array-like data entries undergo the same native typed-element conversions as arrays. */
describe('written typed array-like element conversions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "new Uint8Array({0:Symbol('bad'),length:1} as never)",
    "new BigInt64Array({0:Symbol('bad'),length:1} as never)",
    "Uint8Array.from({0:Symbol('bad'),length:1} as never)",
    "BigInt64Array.from({0:Symbol('bad'),length:1} as never)",
    "new Uint8Array(1).set({0:Symbol('bad'),length:1} as never)",
    "new BigInt64Array(1).set({0:Symbol('bad'),length:1} as never)",
    "(()=>{const source={0:Symbol('bad'),length:1};return new Uint8Array(source as never);})()",
    "new Uint8Array({0:1,1:Symbol('bad'),length:2} as never)",
  ])('refuses a necessarily converted own Symbol entry: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "new Uint8Array({0:Symbol('ignored'),length:0} as never)",
    "new Uint8Array({0:1,1:Symbol('ignored'),length:1} as never)",
    "Uint8Array.from({0:Symbol('mapped'),length:1} as never,()=>1)",
    "new Uint8Array({0:Symbol('ignored'),get length(){return 0;}} as never)",
    "(()=>{const source={get 0(){this[1]=2 as never;return 1;},1:Symbol('repaired'),length:2};return new Uint8Array(source as never);})()",
    "(()=>{const source={0:Symbol('repaired'),length:1};return new Uint8Array(1).set(source as never,(source[0]=1 as never,0));})()",
    "(()=>{const saved=Uint8Array;try{globalThis.Uint8Array=class{} as never;return new Uint8Array({0:Symbol('unused'),length:1} as never);}finally{globalThis.Uint8Array=saved;}})()",
    "(()=>{const source={0:Symbol('repaired'),length:1};source[0]=1 as never;return new Uint8Array(source as never);})()",
    "new Uint8Array({0:Symbol('unused'),length:1,*[Symbol.iterator](){yield 1;}} as never)",
    "(()=>{try{return new Uint8Array({0:Symbol('caught'),length:1} as never);}catch{return first;}})()",
    "false&&new Uint8Array({0:Symbol('skipped'),length:1} as never)",
    "(()=>new Uint8Array({0:Symbol('deferred'),length:1} as never))",
  ])('keeps unused, mapped, changed and unknown conversions: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
