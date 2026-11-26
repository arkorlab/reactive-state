import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** Each native operation runs before an authority-started ordinary string. */
const fixture = stateFixture('static-factory-results', 'StaticFactoryResults');

/** Native factories validate capability functions or actual typed-array construction results. */
describe('static factory construction results', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Promise.resolve.call(Array,1)',
    'Promise.reject.call(Array,1)',
    'Promise.all.call(Array,[])',
    'Promise.allSettled.call(Array,[])',
    'Promise.any.call(Array,[])',
    'Promise.race.call(Array,[])',
    'Promise.resolve.apply(Object,[1])',
    'Reflect.apply(Promise.resolve,Date,[1])',
    'Uint8Array.of.call(class{},1)',
    'Uint8Array.from.call(class{},[1])',
    'Reflect.apply(Uint16Array.of,class{},[1])',
    '(()=>{class Empty{}return Uint8Array.of.call(Empty,1);})()',
    'Uint8Array.of.call(class{constructor(){}},1)',
    'Promise.resolve.call(class{} as never,1)',
  ])('refuses a necessarily invalid native call: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Promise.resolve.call(Promise,1)',
    'Promise.resolve.call(class extends Promise{},1)',
    'Promise.resolve.call(function(executor:Function){executor(()=>{},()=>{});} as never,1)',
    'Promise.resolve.call(class{constructor(executor:Function){executor(()=>{},()=>{});}} as never,1)',
    'Uint8Array.of.call(class extends Uint16Array{},1)',
    'Uint8Array.from.call(class{constructor(length:number){return new Uint16Array(length);}} as never,[1,2])',
    'Uint8Array.of.call(function(length:number){return new Uint16Array(length);} as never,1)',
    '(()=>{const original=Promise.resolve;try{Promise.resolve=(()=>first) as never;return (()=>Promise.resolve.call(Array,1))();}finally{Promise.resolve=original;}})()',
    '(()=>{const original=Uint8Array.of;try{Uint8Array.of=(()=>first) as never;return Uint8Array.of.call(class{},1);}finally{Uint8Array.of=original;}})()',
    '(()=>{try{return Promise.resolve.call(Array,1);}catch{return first;}})()',
    'false&&Uint8Array.of.call(class{},1)',
    '(()=>Promise.resolve.call(Array,1))',
    "(()=>{function keep(value:unknown){return Promise.resolve.call(Array,value);}const value=Promise.resolve(first);Object.defineProperty(value,'constructor',{value:Array});return keep(value);})()",
  ])('keeps valid constructors, raw objects and evaluation boundaries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
