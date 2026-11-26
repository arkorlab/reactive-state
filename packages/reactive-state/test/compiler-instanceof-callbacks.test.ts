import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The hook's boolean result is discarded before the authority selects a JSON state value. */
const fixture = stateFixture('instanceof-callbacks', 'InstanceofCallbacks');

/** Instance membership synchronously calls the final own Symbol.hasInstance method. */
describe('written instance hook callbacks', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '1 instanceof({[Symbol.hasInstance](){throw new Error("hook");}} as never)',
    '1 instanceof({[Symbol.hasInstance]:()=>{throw new Error("hook");}} as never)',
    '1 instanceof({[Symbol.hasInstance]:function(){throw new Error("hook");}} as never)',
    '(()=>{function hook(){throw new Error("hook");}return 1 instanceof({[Symbol.hasInstance]:hook} as never);})()',
    '(()=>{const KEY=Symbol.hasInstance;const hook=()=>decodeURIComponent("%");return 1 instanceof({[KEY]:hook} as never);})()',
  ])('refuses an own instance hook that always throws: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '1 instanceof({[Symbol.hasInstance](){return false;}} as never)',
    '1 instanceof({[Symbol.hasInstance]:async()=>{throw new Error("later");}} as never)',
    '1 instanceof({*[Symbol.hasInstance](){throw new Error("later");}} as never)',
    '(()=>{try{return 1 instanceof({[Symbol.hasInstance](){throw new Error("caught");}} as never);}catch{return false;}})()',
    '(()=>1 instanceof({[Symbol.hasInstance](){throw new Error("deferred");}} as never))',
    'false&&(1 instanceof({[Symbol.hasInstance](){throw new Error("skipped");}} as never))',
    '1 instanceof({[Symbol.hasInstance](){throw new Error("replaced");},[Symbol.hasInstance](){return false;}} as never)',
    '(()=>{const target={[Symbol.hasInstance](){throw new Error("replaced");}};Object.defineProperty(target,Symbol.hasInstance,{value:()=>false});return 1 instanceof(target as never);})()',
  ])('keeps returning, deferred, caught, skipped and replaced hooks: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
