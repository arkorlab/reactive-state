import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

const fixture = stateFixture('proxy-trap-results', 'ProxyTrapResults', 'parenthesized');

describe('source-written Proxy trap return shapes', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Object.keys(new Proxy({}, {ownKeys(){return 1 as never;}}))',
    'Reflect.ownKeys(new Proxy({}, {ownKeys(){return null as never;}}))',
    'Object.values(new Proxy({}, {ownKeys(){return "keys" as never;}}))',
    'Object.entries(new Proxy({}, {ownKeys(){return undefined as never;}}))',
    'Object.keys(new Proxy({}, {ownKeys(){return [1] as never;}}))',
    'Object.keys(new Proxy({}, {ownKeys(){return [{}] as never;}}))',
    'Object.keys(new Proxy({}, {ownKeys(){return [true] as never;}}))',
    'Reflect.ownKeys(new Proxy({}, {ownKeys(){return [1n] as never;}}))',
    'Object.keys(new Proxy({}, {ownKeys(){return ["a","a"];}}))',
    'Object.keys(new Proxy({}, {ownKeys(){return [,] as never;}}))',
    'Object.keys(new Proxy({}, {ownKeys:()=>1 as never}))',
  ])('refuses an invalid consumed ownKeys result: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Object.keys(new Proxy({}, {ownKeys(){return [];}}))',
    'Reflect.ownKeys(new Proxy({}, {ownKeys(){return ["a",Symbol("s")];}}))',
    'Object.keys(new Proxy({}, {ownKeys(){return {length:0} as never;}}))',
    'Object.keys(new Proxy({}, {get ownKeys(){return undefined;}}))',
    'Object.keys(new Proxy({}, {set ownKeys(_value:unknown){throw new Error("unused");}}))',
    'Object.keys(new Proxy({}, {ownKeys:async()=>[] as never}))',
    'Object.keys(new Proxy({}, {*ownKeys(){yield "unused";}} as never))',
    '(new Proxy({}, {get(){return 1;}}) as {value:number}).value',
    'Reflect.has(new Proxy({}, {has(){return 1 as never;}}),"a")',
    'Object.keys(new Proxy({}, {ownKeys(){return 1 as never;},ownKeys(){return [];}}))',
    '(()=>{try{return Object.keys(new Proxy({}, {ownKeys(){return 1 as never;}}));}catch{return first;}})()',
    '(()=>Object.keys(new Proxy({}, {ownKeys(){return 1 as never;}})))',
    'false&&Object.keys(new Proxy({}, {ownKeys(){return 1 as never;}}))',
    '(()=>{const original=Object.keys;try{Object.keys=(()=>[]) as never;return(()=>Object.keys(new Proxy({}, {ownKeys(){return 1 as never;}})))();}finally{Object.keys=original;}})()',
    'Object.keys(new Proxy({}, {ownKeys(){return first as never;}}))',
    '(()=>{const original=Symbol;try{return Object.keys(new Proxy((globalThis.Symbol=(()=>[]) as never,{}),{ownKeys(){return Symbol("key") as never;}}));}finally{globalThis.Symbol=original;}})()',
  ])('keeps valid, ignored, unknown and unexecuted traps: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
