import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

const fixture = stateFixture('sort-callback-counts', 'SortCallbackCounts');

/** Native array sorting compares only defined values, never undefined entries or holes. */
describe('written array sort callback counts', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "[undefined,undefined].sort(()=>{throw new Error('unused');})",
    "[undefined,undefined].toSorted(()=>{throw new Error('unused');})",
    "[void 0,2,void 1].sort(()=>{throw new Error('unused');})",
    "[void 0,2,void 1].toSorted(()=>{throw new Error('unused');})",
    "(()=>{const empty=undefined;return [empty,1,empty].sort(()=>{throw new Error('unused');});})()",
    "(()=>{const empty=void 0;return [empty,1,empty].toSorted(()=>{throw new Error('unused');});})()",
    "[,,undefined,2].sort(()=>{throw new Error('unused');})",
    "[,,undefined,2].toSorted(()=>{throw new Error('unused');})",
    "(()=>{const inputs:{maybe?:string}={};return [inputs.maybe,1].sort(()=>{throw new Error('unused');});})()",
    "(()=>{const read=()=>undefined;return [read(),1].toSorted(()=>{throw new Error('unused');});})()",
  ])('keeps fewer than two proven defined comparator values: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    "[2,1].sort(()=>{throw new Error('compared');})",
    "[2,undefined,1].toSorted(()=>{throw new Error('compared');})",
    "[null,null].sort(()=>{throw new Error('compared');})",
    "[false,0,undefined].toSorted(()=>{throw new Error('compared');})",
    "[first,first].sort(()=>{throw new Error('guarded');})",
    "[first,first].toSorted(()=>{throw new Error('guarded');})",
  ])('refuses a throwing comparator reached by two defined values: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('which no JSON holds'),
    ]);
  });

  it.each([
    "[].sort(()=>{throw new Error('empty');})",
    "[1].toSorted(()=>{throw new Error('single');})",
    "[2,1].sort(function*(){throw new Error('deferred');})",
    '[2,1,undefined].toSorted(()=>0)',
    "(()=>{try{return [2,1].sort(()=>{throw new Error('caught');});}catch{return first;}})()",
    "false&&[2,1].sort(()=>{throw new Error('skipped');})",
    "(()=>{const values=[2,1];values.sort=(()=>[]) as never;return values.sort(()=>{throw new Error('unused');});})()",
    "(()=>{const values=[2,1];return values.sort(()=>{throw new Error('unused');},(values.length=0,undefined));})()",
    "(first=undefined as never,[first,first].sort(()=>{throw new Error('unused');}))",
    "[first=undefined as never,first].toSorted(()=>{throw new Error('unused');})",
  ])('keeps deferred, handled, replaced and argument-repaired work: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
