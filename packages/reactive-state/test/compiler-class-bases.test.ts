import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The class is defined eagerly but the resulting class value is discarded before JSON selection. */
const fixture = stateFixture('class-bases', 'ClassBases');

/** Defining a derived class validates its base before any constructor can run. */
describe('written class heritage values', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(class extends (1 as never){})',
    '(class extends (undefined as never){})',
    '(class extends (false as never){})',
    '(class extends (Symbol() as never){})',
    '(class extends ({} as never){})',
    '(class extends ([] as never){})',
    '(class extends ((()=>0) as never){})',
    '(class extends ((async function(){}) as never){})',
    '(class extends ((function*(){}) as never){})',
    '(class extends (({run(){}}).run as never){})',
    '(class{static child=class extends (1 as never){};})',
  ])('refuses a known nonconstructable base: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(class extends null{})',
    '(class extends (class {}){})',
    '(class extends (function(){}){})',
    '(class extends Object{})',
    '(class extends ((()=>{void first;return class {};})() as never){})',
    '(()=>{function Base(){}return class extends Base{};})()',
    '(()=>{const Base=class {};return class extends Base{};})()',
    '(()=>{try{return class extends (1 as never){};}catch{return 0;}})()',
    '(()=>class extends (1 as never){})',
    'false && (class extends (1 as never){})',
    '(class{child=class extends (1 as never){};})',
  ])('keeps valid, unknown, caught and deferred bases: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
