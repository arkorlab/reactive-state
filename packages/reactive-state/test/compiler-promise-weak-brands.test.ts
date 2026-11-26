import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The native operation runs before the authority receives an ordinary trailing string. */
const fixture = stateFixture('promise-weak-brands', 'PromiseWeakBrands');

/** Promise's then requires its internal slots; catch and finally retain their generic behavior. */
describe('borrowed Promise receiver brands', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Promise.prototype.then.call({} as never,()=>{})',
    'Promise.prototype.then.apply([] as never,[])',
    'Reflect.apply(Promise.prototype.then,null,[])',
    'Promise.prototype.then.call(1 as never)',
    'Promise.prototype.then.call(false as never)',
    '(()=>{const receiver={};return Promise.prototype.then.call(receiver as never);})()',
  ])('refuses a known receiver without Promise slots: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Promise.prototype.then.call(new Promise(()=>{}))',
    'Promise.prototype.then.call(Promise.resolve(first))',
    'Promise.prototype.catch.call({then(){return first;}} as never,()=>{})',
    'Promise.prototype.finally.call({then(){return first;}} as never,()=>{})',
    'Promise.prototype.finally.call({then(){return first;},constructor:undefined} as never)',
    '({then(){return first;}}).then.call({})',
    '(()=>{Promise.prototype.then=(()=>first) as never;return Promise.prototype.then.call({} as never);})()',
    '(Promise.prototype.then=(()=>first) as never,Promise.prototype.then.call({} as never))',
    '(()=>{function replace(){Promise.prototype.then=(()=>first) as never;}replace();return Promise.prototype.then.call({} as never);})()',
    '(()=>{try{return Promise.prototype.then.call({} as never);}catch{return first;}})()',
    '(()=>Promise.prototype.then.call({} as never))',
    'false&&Promise.prototype.then.call({} as never)',
  ])('keeps genuine, generic, changed and deferred receivers: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
