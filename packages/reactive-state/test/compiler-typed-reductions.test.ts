import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority checks the discarded reduction before starting its JSON state. */
const fixture = stateFixture('typed-reductions', 'TypedReductions');

/** An empty native typed-array reduction needs an initial value before any callback is invoked. */
describe('written empty typed-array reductions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'new Uint8Array([]).reduce(()=>0)',
    'new Uint8Array([]).reduceRight(()=>0)',
    'new Uint8Array().reduce(()=>0)',
    'new Uint8Array(0).reduceRight(()=>0)',
    'new Int32Array([]).reduce(()=>0)',
    'new BigInt64Array([]).reduce(()=>0n)',
    'new Uint8Array([]).reduce((async()=>0) as never)',
    'new Uint8Array([]).reduce((function*(){return 0;}) as never)',
    '(()=>{const Bytes=Uint8Array;const values=new Bytes([]);return values.reduce(()=>0);})()',
    '(()=>{const input:number[]=[];return new Uint8Array(input).reduceRight(()=>0);})()',
    'new Uint8Array(0.5).reduce(()=>0)',
  ])('refuses an empty reduction with no initial value: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'new Uint8Array([]).reduce(()=>0,0)',
    'new Uint8Array([]).reduceRight(()=>0,0)',
    'new Uint8Array([]).reduce(()=>0,undefined as never)',
    'new BigInt64Array([]).reduce(()=>0n,0n)',
    'new Uint8Array([1]).reduce(()=>{throw new Error("unused");})',
    'new Uint8Array([1]).reduceRight(()=>{throw new Error("unused");})',
    'new Uint8Array(Number(first)).reduce(()=>0)',
    '(()=>{const values=new Uint8Array([]);values.reduce=()=>0;return values.reduce(()=>0);})()',
    '(()=>{class Uint8Array{reduce(_callback:()=>number){return 0;}}return new Uint8Array().reduce(()=>0);})()',
    '(()=>{try{new Uint8Array([]).reduce(()=>0);}catch{}return first;})()',
    'false&&new Uint8Array([]).reduce(()=>0)',
    '()=>new Uint8Array([]).reduce(()=>0)',
    '(()=>{const saved=Uint8Array.prototype.reduce;try{return new Uint8Array((Uint8Array.prototype.reduce=(()=>0) as never,[])).reduce(()=>0);}finally{Uint8Array.prototype.reduce=saved;}})()',
  ])(
    'keeps initial values, nonempty, unknown, changed and handled reductions: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});
