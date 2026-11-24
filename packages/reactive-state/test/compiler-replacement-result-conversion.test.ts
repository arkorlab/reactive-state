import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The prop branch discards the replacement result before the authority starts its JSON state. */
const fixture = stateFixture('replacement-result-conversion', 'ReplacementResultConversion');

/** Replacement callbacks return values that the native consumer converts to text. */
describe('written replacement result conversions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '"a".replace("a",()=>Symbol("result") as never)',
    '"a".replaceAll("a",()=>Symbol("result") as never)',
    '"".replace("",()=>Symbol("result") as never)',
    '"abc".replace("b",function(){return Symbol.iterator as never;})',
  ])('refuses a necessarily converted Symbol replacement result: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '"a".replaceAll("a",()=>1n as never)',
    '"a".replace("a",()=>1 as never)',
    '"a".replace("a",()=>"bad")',
    '"a".replace("b",()=>Symbol("unused") as never)',
    '"".replace("a",()=>Symbol("unused") as never)',
    'first.replace("a",()=>Symbol("uncertain") as never)',
    '"a".replace(first,()=>Symbol("uncertain") as never)',
    '"a".replace("a",(async()=>Symbol("deferred")) as never)',
    '"a".replace("a",(function*(){return Symbol("deferred");}) as never)',
    '(()=>{try{"a".replace("a",()=>Symbol("caught") as never);}catch{}return first;})()',
    '(()=>{const original=Symbol;try{return(globalThis.Symbol=(()=>0) as never,"a".replace("a",()=>Symbol("changed") as never));}finally{globalThis.Symbol=original;}})()',
    '"a".replace("a",(Symbol:string)=>Symbol)',
    '"a".replace("a",(piece=Symbol("unused default"))=>piece as never)',
    '"a".replace("a",(()=>{}) as never)',
  ])('keeps valid, unknown, absent, deferred and handled results: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
