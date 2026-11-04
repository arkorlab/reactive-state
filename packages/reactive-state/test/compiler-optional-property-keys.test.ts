import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The optional read is evaluated before the authority receives a trailing JSON string. */
const fixture = stateFixture('optional-property-keys', 'OptionalPropertyKeys');

/** Optional links can skip key conversion, including later members in the same raw chain. */
describe('optional property key conversion', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(first as unknown as {}|null)?.[Object.create(null) as never]',
    '(first as unknown as {a:{}}|null)?.a[Object.create(null) as never]',
    '(first as unknown as (()=>{})|null)?.()[Object.create(null) as never]',
    '(first as unknown as {a:{}}|null)?.a![Object.create(null) as never]',
    '(first?{}:null)?.[Object.create(null) as never]',
    '(first as unknown as {a:{}|null}|null)?.a?.[Object.create(null) as never]',
  ])('keeps a conversion that an unknown optional receiver may skip: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    '({})?.[Object.create(null) as never]',
    '([])?.[Object.create(null) as never]',
    '"x"?.[Object.create(null) as never]',
    '(0)?.[Object.create(null) as never]',
    'false?.[Object.create(null) as never]',
    '(new Object())?.[Object.create(null) as never]',
    '({a:{}})?.a[Object.create(null) as never]',
    '((first as unknown as {a:{}}|null)?.a)[Object.create(null) as never]',
    '(first as never)[Object.create(null) as never]',
    '(()=>{const receiver={};return receiver?.[Object.create(null) as never];})()',
  ])('refuses a key conversion that cannot short-circuit: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(null as {a:{}}|null)?.a[Object.create(null) as never]',
    '(undefined as {}|undefined)?.[Object.create(null) as never]',
    '({})?.[Symbol("key")]',
    '({})?.[({__proto__:null,toString(){return "key";}}) as never]',
    '(()=>{try{return({})?.[Object.create(null) as never];}catch{return first;}})()',
    '(()=>({})?.[Object.create(null) as never])',
  ])('keeps known short-circuiting, valid conversion and deferred work: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
