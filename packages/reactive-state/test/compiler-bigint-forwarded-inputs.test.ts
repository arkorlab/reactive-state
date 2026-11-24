import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The native call executes before the authority receives a trailing JSON string. */
const fixture = stateFixture('bigint-forwarded-inputs', 'BigIntForwardedInputs');

/** Native ToNumber arguments reject BigInt, while explicit conversions and ignored slots retain it. */
describe('forwarded BigInt native numeric arguments', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Math.abs.call(undefined,3n as never)',
    'Math.abs.apply(undefined,[3n as never])',
    'Reflect.apply(Math.abs,undefined,[3n])',
    'String.fromCodePoint.call(undefined,65n as never)',
    '(()=>{const abs=Math.abs;return abs.call(undefined,3n as never);})()',
    'Math.max.apply(undefined,[0,3n as never])',
    'Math.abs.call(...[undefined,3n as never] as const)',
    'Math.abs(...[3n as never] as const)',
  ])('refuses a BigInt in a native number-coercing slot: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Number.call(undefined,3n)',
    'Reflect.apply(Number.isFinite,undefined,[3n])',
    '(Math.abs.call as Function)(undefined,3,4n)',
    'Math.abs.apply(undefined,[3,4n] as never)',
    '(()=>{const args=[3n] as (number|bigint)[];args[0]=3;return Math.abs.apply(undefined,args as never);})()',
    '(()=>{const math=Math;math.abs=(()=>1) as never;return math.abs.call(undefined,3n as never);})()',
    '(()=>{const abs=Math.abs;abs.call=(()=>1) as never;return abs.call(undefined,3n as never);})()',
    'Reflect.apply((Math.abs=(()=>1) as never),undefined,[3n])',
    '(()=>{try{return Math.abs.call(undefined,3n as never);}catch{return first;}})()',
    '(()=>Math.abs.call(undefined,3n as never))',
    'false&&Reflect.apply(Math.abs,undefined,[3n])',
    '(()=>{const Math={abs:{call(_self:undefined,_value:bigint){return 1;}}};return Math.abs.call(undefined,3n);})()',
  ])('keeps explicit, ignored, custom and deferred native inputs: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
