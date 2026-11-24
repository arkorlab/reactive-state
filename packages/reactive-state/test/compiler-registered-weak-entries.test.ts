import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The constructed collection is discarded only after its entries have been consumed. */
const fixture = stateFixture('registered-weak-entries', 'RegisteredWeakEntries');

/** Registered symbols cannot be held weakly, unlike ordinary and well-known symbols. */
describe('registered Symbol weak collection entries', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "new WeakMap([[Symbol.for('held'),first]])",
    "new WeakSet([Symbol.for('held')])",
    "(()=>{const key=Symbol.for('held');return new WeakMap([[key,first]]);})()",
    "(()=>{const make=Symbol.for;return new WeakSet([make('held')]);})()",
    "(()=>{const entries=[[Symbol.for('held'),first]] as const;return new WeakMap(entries);})()",
    "new WeakSet([globalThis.Symbol.for('held')])",
  ])('refuses source-proven registered weak entries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "new WeakMap([[Symbol('held'),first]])",
    "new WeakSet([Symbol('held')])",
    'new WeakSet([Symbol.iterator])',
    'new WeakMap([[{},first]])',
    'new WeakSet([()=>first])',
    'new WeakMap()',
    'new WeakSet([])',
    "(()=>{const entries:unknown[]=[Symbol.for('held')];entries[0]={};return new WeakSet(entries as never);})()",
    "(()=>{Symbol.for=(()=>({})) as never;return new WeakSet([Symbol.for('held')]);})()",
    'new WeakSet([Symbol.for((void(WeakSet.prototype.add=(()=>({})) as never)) as never)])',
    "(()=>{globalThis.WeakMap=class {} as never;return new WeakMap([[Symbol.for('held'),first]]);})()",
    "(()=>{try{return new WeakSet([Symbol.for('held')]);}catch{return first;}})()",
    "false&&new WeakMap([[Symbol.for('held'),first]])",
  ])('keeps valid weak values, replacements and handled calls: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
