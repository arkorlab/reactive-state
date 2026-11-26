import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The constructed collection is discarded only after its entries have been consumed. */
const fixture = stateFixture('weak-symbol-aliases', 'WeakSymbolAliases');

/** Captured native symbol makers retain their identity while quiet entry arrays are constructed. */
describe('registered Symbol maker and entry aliases', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "(()=>{const maker=Symbol.for;const values=[maker('set')];return new WeakSet(values);})()",
    "(()=>{const maker=Symbol.for;const key=maker('map');const values=[[key,first]] as const;return new WeakMap(values);})()",
  ])('refuses registered makers through retained entry arrays: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "(()=>{const maker=Symbol;const values=[maker('set')];return new WeakSet(values);})()",
    "(()=>{const maker=Symbol.for;const values:unknown[]=[maker('set')];values[0]={};return new WeakSet(values as never);})()",
    "(()=>{Symbol.for=(()=>({})) as never;const maker=Symbol.for;const values=[maker('set')];return new WeakSet(values);})()",
    "(()=>{const maker=Symbol.for;const values=[maker('set')];WeakSet.prototype.add=(()=>({})) as never;return new WeakSet(values);})()",
    "(()=>{const maker=(_key:string)=>({});const values=[maker('set')];return new WeakSet(values);})()",
    "(()=>{const maker=Symbol.for;const values=[maker('set')];try{return new WeakSet(values);}catch{return first;}})()",
  ])('keeps ordinary makers, repaired entries and native overrides: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
