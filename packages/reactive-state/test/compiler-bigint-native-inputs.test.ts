import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The native call executes before the authority receives a trailing JSON string. */
const fixture = stateFixture('bigint-native-inputs', 'BigIntNativeInputs');

/** Native ToNumber arguments reject BigInt, while explicit conversions and ignored slots retain it. */
describe('written BigInt native numeric arguments', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Math.abs(1n as never)',
    'Math.trunc(2n as never)',
    'Math.pow(2,1n as never)',
    'Math.max(0,1n as never)',
    'isFinite(1n as never)',
    'isNaN(1n as never)',
    'Date.UTC(1n as never,0)',
    'Date.UTC(2020,0,1n as never)',
    'String.fromCodePoint(65n as never)',
    'String.fromCharCode(65n as never)',
    'Math.abs(BigInt(1) as never)',
    'Math.abs(BigInt.asIntN(8,1n) as never)',
    '(()=>{const value=1n;return Math.abs(value as never);})()',
    '(()=>{const abs=Math.abs;return abs(1n as never);})()',
    '(()=>{const math=Math;return math.trunc(1n as never);})()',
    'Math.floor(-1n as never)',
  ])('refuses a BigInt in a native number-coercing slot: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Number(1n)',
    'new Number(1n)',
    'Number.isFinite(1n)',
    'Number.isNaN(1n)',
    'String(1n)',
    'parseInt(1n as never)',
    'parseFloat(1n as never)',
    '(Math.abs as Function)(1,2n)',
    '(Math.pow as Function)(2,3,4n)',
    '(Math.random as Function)(1n)',
    '(Date.UTC as Function)(2020,0,1,0,0,0,0,1n)',
    'Math.abs({valueOf(){return 1;}} as never)',
    '(()=>{const math=Math;math.abs=(()=>1) as never;return math.abs(1n as never);})()',
    '(()=>{const Math={abs(_value:bigint){return 1;}};return Math.abs(1n);})()',
    '(()=>{try{return Math.abs(1n as never);}catch{return first;}})()',
    '(()=>Math.abs(1n as never))',
    'false&&Math.abs(1n as never)',
  ])('keeps explicit, ignored, custom and deferred native inputs: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
