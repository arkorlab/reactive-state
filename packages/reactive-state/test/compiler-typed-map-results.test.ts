import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

const fixture = stateFixture('typed-map-results', 'TypedMapResults', 'parenthesized');

describe('typed array map result conversion', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'new Uint8Array([1]).map(()=>1n as never)',
    'new Float32Array([1]).map(()=>Symbol("result") as never)',
    'new BigInt64Array([1n]).map(()=>1 as never)',
    'new BigUint64Array(1).map(()=>null as never)',
    'new BigInt64Array(1).map((()=>{}) as never)',
    'new BigInt64Array(1).map(()=>"bad" as never)',
    'new Uint8Array(1).map(function(){return 1n as never;})',
    '(()=>{const Bytes=Uint16Array;return new Bytes([1]).map(()=>1n as never);})()',
    '(()=>{const bytes=new Uint8Array([1]);return bytes.map(()=>1n as never);})()',
    '(()=>{const mapper=()=>1n as never;return new Uint8Array([1]).map(mapper);})()',
  ])('refuses a guaranteed incompatible mapped element: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'new Uint8Array(0).map(()=>1n as never)',
    'new BigInt64Array(0).map(()=>1 as never)',
    'new Uint8Array(Number(first)).map(()=>1n as never)',
    'new Uint8Array([1]).map(()=>2)',
    'new BigInt64Array([1n]).map(()=>2n)',
    'new BigInt64Array([1n]).map(()=>true as never)',
    'new BigInt64Array([1n]).map(()=>"7" as never)',
    'new Uint8Array([1]).map((()=>{}) as never)',
    '[1].map(()=>1n)',
    '(()=>{const bytes=new Uint8Array([1]);bytes.map=(()=>new Uint8Array(0)) as never;return bytes.map(()=>1n as never);})()',
    '(()=>{const original=Symbol;try{return new Uint8Array([+{valueOf(){globalThis.Symbol=(()=>2) as never;return 1;}}]).map(()=>Symbol("result") as never);}finally{globalThis.Symbol=original;}})()',
    '(()=>{const original=Symbol;try{return(globalThis.Symbol=(()=>2) as never,new Uint8Array([1]).map(()=>Symbol("result") as never));}finally{globalThis.Symbol=original;}})()',
    '(()=>{try{return new Uint8Array([1]).map(()=>1n as never);}catch{return first;}})()',
    '(()=>new Uint8Array([1]).map(()=>1n as never))',
    'false&&new Uint8Array([1]).map(()=>1n as never)',
    'new Uint8Array([1]).map(async()=>1 as never)',
    'new Uint8Array([1]).map((function*(){yield 1;}) as never)',
    'new Uint8Array([1]).map(Symbol=>Symbol)',
    '(()=>{const original=Symbol;try{return new Uint8Array([{valueOf(){globalThis.Symbol=(()=>2) as never;return 1;}} as never]).map(()=>Symbol("result") as never);}finally{globalThis.Symbol=original;}})()',
  ])('keeps empty, compatible, changed and unexecuted maps: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
