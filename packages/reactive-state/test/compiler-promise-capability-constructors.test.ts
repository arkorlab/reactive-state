import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The native capability operation precedes a discarded result in an authority-started state. */
const fixture = stateFixture('promise-capability-constructors', 'PromiseCapabilityConstructors');

/** Known native constructors other than Promise never initialize capability executor functions. */
describe('native Promise capability constructors', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Promise.resolve.call(WeakMap,1)',
    'Promise.resolve.call(WeakSet,1)',
    'Promise.resolve.call(WeakRef,1)',
    'Promise.resolve.call(FinalizationRegistry,1)',
    'Promise.reject.call(WeakRef,1)',
    'Promise.all.call(WeakSet,[])',
    'Promise.race.call(FinalizationRegistry,[])',
    'Reflect.apply(Promise.resolve,WeakMap,[1])',
    '(()=>{const Receiver=WeakRef;return Promise.resolve.call(Receiver,1);})()',
    'Promise.resolve.call(Proxy,1)',
    'Promise.resolve.call(DataView,1)',
  ])('refuses a known constructor without Promise capability functions: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Promise.resolve.call(Promise,1)',
    "(()=>{const value=Promise.resolve(first);Object.defineProperty(value,'constructor',{value:WeakRef});return Promise.resolve.call(WeakRef,value)===value;})()",
    '(()=>{class WeakMap{constructor(executor:Function){executor(()=>{},()=>{});}}return Promise.resolve.call(WeakMap,1);})()',
    'Promise.resolve.call(function(executor:Function){executor(()=>{},()=>{});} as never,1)',
    '(()=>{const saved=Promise.resolve;try{Promise.resolve=(()=>first) as never;return Promise.resolve.call(WeakMap,1);}finally{Promise.resolve=saved;}})()',
    '(()=>{let Receiver=WeakRef;Receiver=class{constructor(executor:Function){executor(()=>{},()=>{});}} as never;return Promise.resolve.call(Receiver,1);})()',
    '(()=>{function use(Receiver:any){return Promise.resolve.call(Receiver,1);}return use(Promise);})()',
    '(()=>{try{return Promise.resolve.call(WeakRef,1);}catch{return first;}})()',
    'false&&Promise.resolve.call(WeakSet,1)',
    '(()=>Promise.resolve.call(FinalizationRegistry,1))',
    'Uint8Array.from.call(Uint16Array,[1,2])',
    'new WeakMap()',
  ])(
    'keeps early returns, generic constructors and evaluation boundaries: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});
