import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The assignment result is discarded before the authority selects a JSON state value. */
const fixture = stateFixture('array-length-writes', 'ArrayLengthWrites');

/** ArraySetLength validates a value even when the existing length descriptor is writable. */
describe('written array length assignments', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '([] as any).length=-1',
    '([] as any).length=0.5',
    '([] as any).length=2**32',
    '([] as any).length=NaN',
    '([] as any).length=Infinity',
    '([] as any).length="-1"',
    '([] as any).length=undefined',
    '([] as any)["length"]=-1',
    '(()=>{const list:any[]=[];list.length=-1;})()',
  ])('refuses a written invalid array length: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '([] as any).length=0',
    '([] as any).length=3',
    '([] as any).length=2**32-1',
    '([] as any).length="2"',
    '([] as any).length=null',
    '([] as any).length=true',
    '({length:0} as any).length=-1',
    '(Object.create([]) as any).length=-1',
    '(()=>{try{([] as any).length=-1;}catch{return "ok";}})()',
    'false&&(([] as any).length=-1)',
    '()=>{([] as any).length=-1;}',
  ])('keeps valid lengths, ordinary objects and escaping boundaries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
