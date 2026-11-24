import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A trailing string keeps result JSON separate from invocation validity. */
const fixture = stateFixture('callable-brands', 'CallableBrands');

/** Class callbacks throw only when invoked; Function methods require a callable receiver. */
describe('written callback and Function brands', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '[first].map(class {})',
    '[first].forEach(class {})',
    '[first].filter(class {})',
    '[first,first].reduce(class {})',
    '[first].reduce(class {},first)',
    '[2,1].sort(class {})',
    'Array.prototype.map.call([first],class {})',
    '(()=>{const Callback=class {};return [first].map(Callback);})()',
    'Function.prototype.toString.call({})',
    'Function.prototype.toString.call(null)',
    'Function.prototype.toString.apply([],[])',
    'Function.prototype.bind.call(/x/)',
    'Function.prototype.toString.call(1n)',
    'Function.prototype.call.call({},null)',
    'Function.prototype.apply.call({},null,[])',
    'Reflect.apply(Function.prototype.bind,{},[])',
  ])(
    'refuses necessarily invoked classes and invalid Function receivers: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
        expect.stringContaining('no JSON holds'),
      ]);
    },
  );

  it.each([
    '[].map(class {})',
    '[,].map(class {})',
    '[first].reduce(class {})',
    '[].reduce(class {},first)',
    '[1].sort(class {})',
    '[undefined,undefined].sort(class {})',
    'Array.from([],class {})',
    'new FinalizationRegistry(class {})',
    'Object.prototype.__defineGetter__.call({},"x",class {})',
    'new Promise(class {})',
    'Function.prototype.toString.call(class {})',
    'Function.prototype.bind.call(class {})',
    'Function.prototype.toString.call(()=>first)',
    'Function.prototype.call.call(()=>first,null)',
    'Function.prototype.apply.call(function*(){throw new Error("deferred");},null,[])',
    'Function.prototype.toString.call(new Function("return 1"))',
    'Function.prototype.constructor.call({},"return 1")',
    'Function.prototype[Symbol.hasInstance].call({},first)',
    '(()=>{const values=[first];return values.map(class {static{values.length=0;}});})()',
    '({map(){return first;}}).map(class {})',
    '(()=>{Function.prototype.toString=(()=>first) as never;return Function.prototype.toString.call({});})()',
    '(()=>{try{return [first].map(class {});}catch{return first;}})()',
    'false&&Function.prototype.toString.call({})',
    '(()=>Function.prototype.toString.call({}))',
  ])('keeps unused classes, callable receivers and native overrides: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
