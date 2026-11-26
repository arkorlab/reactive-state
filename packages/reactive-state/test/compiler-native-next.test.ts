import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** Each native operation precedes a discarded result in an authority-started state. */
const fixture = stateFixture('native-next', 'NativeNext');

/** Native RegExp, iterator, membership, locale and callback work can fail before a JSON result. */
describe('additional written native exception shapes', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "/x/.compile(/a/ as never,'g')",
    "/x/.compile(/a/ as never,'')",
    "(()=>{const pattern=/a/;return /x/.compile(pattern as never,'i');})()",
    "RegExp.prototype.compile.call(/x/,/a/ as never,'g')",
    "RegExp.prototype.compile.call({} as never,'a')",
    "RegExp.prototype.compile.call({exec(){return null;}} as never,'a')",
    "RegExp.prototype.compile.apply([] as never,['a'])",
    "Reflect.apply(RegExp.prototype.compile,1,['a'])",
    'new(Iterator as never)()',
    '(()=>{const Abstract=Iterator;return new(Abstract as never)();})()',
    '({} instanceof (()=>0) as never)',
    '([] instanceof (async function(){}) as never)',
    '({} instanceof ({method(){}}).method as never)',
    '[{toLocaleString:1 as never}].toLocaleString()',
    "[{toLocaleString(){throw new Error('element');}}].toLocaleString()",
    "[{get toLocaleString(){throw new Error('element getter');}}].toLocaleString()",
    'queueMicrotask(1 as never)',
    'queueMicrotask(null as never)',
    '(queueMicrotask as Function)()',
    'queueMicrotask({} as never)',
  ])('refuses necessarily throwing native work: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '/x/.compile(/a/)',
    '/x/.compile(/a/ as never,undefined)',
    "/x/.compile('a','g')",
    "({compile(){return first;}}).compile(/a/,'g')",
    "RegExp.prototype.compile.call(/x/,'a')",
    "Reflect.apply(RegExp.prototype.compile,/x/,['a'])",
    "(()=>{const old=RegExp.prototype.compile;try{RegExp.prototype.compile=(()=>first) as never;return (()=>RegExp.prototype.compile.call({} as never,'a'))();}finally{RegExp.prototype.compile=old;}})()",
    'new(class extends Iterator<number>{next(){return{done:true as const,value:1};}})()',
    '(()=>{class Iterator{}return new Iterator();})()',
    '(()=>{const old=globalThis.Iterator;try{globalThis.Iterator=class{} as never;return new(globalThis.Iterator as never)();}finally{globalThis.Iterator=old;}})()',
    '(1 instanceof (()=>0) as never)',
    '({} instanceof (function*(){}) as never)',
    '({} instanceof (async function*(){}) as never)',
    "(()=>{const fn=()=>0;Object.defineProperty(fn,'prototype',{value:{}});return {} instanceof fn;})()",
    '(()=>{const fn=()=>0;Object.defineProperty(fn,Symbol.hasInstance,{value(){return true;}});return {} instanceof fn;})()',
    '[].toLocaleString()',
    '[null,undefined].toLocaleString()',
    '[{toLocaleString(){return first;}}].toLocaleString()',
    '[{toLocaleString:()=>1}].toLocaleString()',
    '(()=>{const values:any=[{toLocaleString:1}];values[0].toLocaleString=()=>first;return values.toLocaleString();})()',
    'queueMicrotask(()=>{})',
    'queueMicrotask(class{} as never)',
    "queueMicrotask(function*(){throw new Error('deferred');})",
    '(()=>{const old=queueMicrotask;try{globalThis.queueMicrotask=(()=>first) as never;return (()=>queueMicrotask(1 as never))();}finally{globalThis.queueMicrotask=old;}})()',
    "(()=>{try{return /x/.compile(/a/ as never,'g');}catch{return first;}})()",
    'false&&new(Iterator as never)()',
    '(()=>queueMicrotask(1 as never))',
    'false&&[{toLocaleString:1 as never}].toLocaleString()',
  ])('keeps normal, changed, skipped and deferred work: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
