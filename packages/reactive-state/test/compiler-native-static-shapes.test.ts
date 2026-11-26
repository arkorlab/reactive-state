import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** Each native operation runs before an authority-started ordinary string. */
const fixture = stateFixture('native-static-shapes', 'NativeStaticShapes');

/** Written static receiver and template shapes fail before a trailing JSON value is returned. */
describe('native static receiver and template shapes', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'Promise.resolve.call(()=>{},1)',
    'Promise.reject.call(()=>{},1)',
    'Promise.all.call(()=>{},[])',
    'Promise.race.call(()=>{},[])',
    'Promise.allSettled.call(()=>{},[])',
    'Promise.any.call(()=>{},[])',
    'Promise.resolve.apply(()=>{},[1])',
    'Reflect.apply(Promise.resolve,()=>{},[1])',
    'Uint8Array.of.call(Array,1)',
    'Uint8Array.from.call(Array,[1])',
    'Uint8Array.of.call(()=>{},1)',
    'Uint8Array.from.apply(Array,[[1]])',
    'Reflect.apply(Uint8Array.of,Date,[1])',
    'String.raw(null as never)',
    'String.raw(undefined as never)',
    '(String.raw as Function)()',
    'String.raw({} as never)',
    'String.raw({raw:null} as never)',
    'String.raw({raw:undefined} as never)',
    "(WebAssembly.Global as Function)({value:'i32'},0)",
    '(WebAssembly.Tag as Function)({parameters:[]})',
    '(WebAssembly.Exception as Function)({},{})',
    "(CompressionStream as Function)('gzip')",
    "(DecompressionStream as Function)('gzip')",
    '(TextDecoderStream as Function)()',
    '(TextEncoderStream as Function)()',
  ])('refuses a necessarily invalid native call: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'Promise.resolve.call(Promise,1)',
    'Promise.resolve.call(class extends Promise {},1)',
    'Promise.resolve.call(function(executor:Function){executor(()=>{},()=>{});} as never,1)',
    '(()=>{const resolve=Promise.resolve;return resolve.call(Promise,1);})()',
    'Uint8Array.of.call(Uint16Array,1)',
    'Uint8Array.from.call(class extends Uint16Array {},[1])',
    'Uint8Array.of.call(function(length:number){return new Uint16Array(length);} as never,1)',
    'Reflect.apply(Uint8Array.from,Uint16Array,[[1]])',
    "String.raw({raw:['a','b']},first)",
    'String.raw({raw:0} as never)',
    "String.raw({get raw(){return ['a'];}})",
    "String.raw({__proto__:{raw:['a']}} as never)",
    "String.raw({raw:null,...{raw:['a']}} as never)",
    "(()=>{const template={} as {raw?:string[]};template.raw=['a'];return String.raw(template as never);})()",
    "new WebAssembly.Global({value:'i32'},0)",
    'new WebAssembly.Tag({parameters:[]})',
    'new WebAssembly.Exception(new WebAssembly.Tag({parameters:[]}),[])',
    "new CompressionStream('gzip')",
    "new DecompressionStream('gzip')",
    'new TextDecoderStream()',
    'new TextEncoderStream()',
    '(()=>{try{return Promise.resolve.call(()=>{},1);}catch{return first;}})()',
    '(()=>String.raw(null as never))',
    'false&&Uint8Array.of.call(Array,1)',
    '(()=>{String.raw=(()=>first) as never;return (()=>String.raw(null as never))();})()',
    "(CompressionStream=(()=>first) as never,(CompressionStream as Function)('gzip'))",
    '(Promise.resolve=(()=>first) as never,Promise.resolve.call(()=>{},1))',
    '(Uint8Array.of=(()=>first) as never,Uint8Array.of.call(Array,1))',
  ])('keeps valid constructors, raw objects and evaluation boundaries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
