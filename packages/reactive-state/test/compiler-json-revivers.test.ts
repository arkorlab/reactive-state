import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The authority evaluates the call before receiving the trailing JSON string. */
const fixture = stateFixture('json-revivers', 'JsonRevivers');

/** JSON.parse synchronously invokes its reviver for the root of any parsed JSON. */
describe('written JSON.parse revivers', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "JSON.parse('0',()=>{throw new Error('bad');})",
    "JSON.parse('{}',function(){throw new Error('bad');})",
    "JSON.parse('[]',()=>{throw new Error('bad');})",
    "JSON.parse('null',()=>{throw new Error('bad');})",
    "JSON.parse('0',()=>decodeURIComponent('%'))",
    "globalThis.JSON['parse']('0',()=>{throw new Error('bad');})",
    "(()=>{const reviver=()=>{throw new Error('bad');};return JSON.parse('0',reviver);})()",
    "(()=>{const json=JSON;return json.parse('0',()=>{throw new Error('bad');});})()",
  ])('refuses a synchronously throwing root reviver: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "JSON.parse('0',(_key,value)=>value)",
    "JSON.parse('0',async()=>1)",
    "JSON.parse('0',function*(){throw new Error('deferred');})",
    "JSON.parse('0',undefined)",
    "(()=>{try{return JSON.parse('0',()=>{throw new Error('caught');});}catch{return 'ok';}})()",
    "false&&JSON.parse('0',()=>{throw new Error('skipped');})",
    "(()=>{const json=JSON;json.parse=(()=>0) as never;return json.parse('0',()=>{throw new Error('ignored');});})()",
    "JSON.parse('0',(key,value)=>{if(key==='missing')throw new Error('branch');return value;})",
  ])('keeps native valid or deferred revivers: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
