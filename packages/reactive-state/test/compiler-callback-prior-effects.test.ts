import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The prop branch discards native results before the authority starts its JSON state. */
const fixture = stateFixture('callback-prior-effects', 'CallbackPriorEffects');

/** Earlier comma operands may change intrinsic work performed by native callbacks. */
describe('written callback evaluation order', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(+1,"a".replace("a",()=>decodeURIComponent("%")))',
    '(+1,Uint8Array.from([1],()=>Symbol() as never))',
    '(+1,[2,1].sort(()=>Symbol() as never))',
  ])('refuses callback failures after quiet comma prefixes: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(()=>{const original=decodeURIComponent;try{return(globalThis.decodeURIComponent=()=>"ok","a".replace("a",()=>decodeURIComponent("%")));}finally{globalThis.decodeURIComponent=original;}})()',
    '(+1,"a".replace("a",()=>first))',
    '(()=>{const original=Symbol;try{return(globalThis.Symbol=(()=>0) as never,Uint8Array.from([1],()=>Symbol() as never));}finally{globalThis.Symbol=original;}})()',
    '(()=>{const original=Symbol;try{return(globalThis.Symbol=(()=>0) as never,[2,1].sort(()=>Symbol() as never));}finally{globalThis.Symbol=original;}})()',
  ])('keeps callback work repaired by earlier comma operands: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
