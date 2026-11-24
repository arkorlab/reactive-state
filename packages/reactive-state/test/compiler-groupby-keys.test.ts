import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority evaluates the grouping call before receiving the trailing JSON string. */
const fixture = stateFixture('groupby-keys', 'GroupByKeys');

/** Object grouping converts a necessarily called callback's result to a property key. */
describe('written Object.groupBy key conversions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Object.groupBy([first],()=>Object.create(null))',
    'Object.groupBy([first],function(){return Object.create(null);})',
    'Object.groupBy([first],()=>({__proto__:null}))',
    'globalThis.Object["groupBy"]("a",()=>Object.create(null))',
    'Object.groupBy([,],()=>Object.create(null))',
    '(()=>{const key=()=>Object.create(null);return Object.groupBy([first],key);})()',
    '(()=>{const items=[first];return Object.groupBy(items,()=>Object.create(null));})()',
  ])('refuses necessarily unconvertible grouping keys: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Map.groupBy([first],()=>Object.create(null))',
    'Object.groupBy([first],()=>Symbol("key"))',
    'Object.groupBy([first],()=>1)',
    'Object.groupBy([first],()=>1n)',
    'Object.groupBy([first],()=>undefined)',
    'Object.groupBy([first],()=>({}))',
    'Object.groupBy([first],()=>({__proto__:null,toString(){return "key";}}))',
    'Object.groupBy([],()=>Object.create(null))',
    'Object.groupBy("",()=>Object.create(null))',
    'Object.groupBy(first,()=>Object.create(null))',
    'Object.groupBy([first],(item)=>item)',
    'Object.groupBy([first],async()=>Object.create(null))',
    'Object.groupBy([first],function*(){return Object.create(null);})',
    '(()=>{try{return Object.groupBy([first],()=>Object.create(null));}catch{return "ok";}})()',
    'false&&Object.groupBy([first],()=>Object.create(null))',
    'Object.groupBy([(globalThis.Object.create=(()=>({})) as never,first)],()=>Object.create(null))',
    'Object.groupBy([first],(item=Object.create(null))=>item)',
  ])('keeps valid, unknown, deferred and handled grouping keys: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
