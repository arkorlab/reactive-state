import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The native call executes before the authority receives a trailing JSON string. */
const fixture = stateFixture('array-method-bounds', 'ArrayMethodBounds');

/** Known native array lengths and indices establish bounds without reading unknown application values. */
describe('written array method bounds', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '[1].with(1,2)',
    '[].with(0,2)',
    '[1].with(-2,2)',
    '[1].with(1.9,2)',
    '(()=>{const values=[1];return values.with(1,2);})()',
    "[1]['with'](Infinity,2)",
    'new Uint8Array(1).set([1],1)',
    'new Int16Array(1).set([1,2])',
    'new Uint8Array(1).set([],2)',
    'new Uint8Array(1).set([],-1)',
    'new Uint8Array(1).set([],Infinity)',
    'new Uint8Array(1).set(new Uint8Array(2))',
    '(()=>{const target=new Uint8Array(1);const source=[1];return target.set(source,1);})()',
    'Uint8Array.prototype.set.call(new Uint8Array(1),[1],1)',
    'Array.prototype.with.call([1],1,2)',
  ])('refuses a native with or set range violation: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '[1].with(0,2)',
    '[1].with(-1,2)',
    '[1].with(-0.9,2)',
    '[1].with(NaN,2)',
    '(()=>{const values=[1];return values.with(1,(values.push(2),0));})()',
    '(()=>{const values=[1];values.push(2);return values.with(1,0);})()',
    '[...[1,2]].with(1,0)',
    '({with(_index:number,_value:number){return 0;}}).with(99,0)',
    'new Uint8Array(1).set([],1)',
    'new Uint8Array(1).set([1],0.9)',
    'new Uint8Array(1).set([1],-0.9)',
    'new Uint8Array(1).set([1],NaN)',
    'new Uint8Array(1).set(new Uint8Array(1))',
    'new BigInt64Array(1).set([1n])',
    'new Uint8Array(1).set({get length(){return 0;}})',
    '(()=>{const source=[1,2];return new Uint8Array(1).set(source,(source.length=0,0));})()',
    '(()=>{const target=new Uint8Array(1);target.set=(()=>{}) as never;return target.set([1,2]);})()',
    '(()=>{try{return [1].with(1,2);}catch{return first;}})()',
    '(()=>new Uint8Array(1).set([1],1))',
    'false&&[1].with(1,2)',
  ])('keeps explicit, ignored, custom and deferred native inputs: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
