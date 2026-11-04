import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A discarded native RegExp operation precedes the state's final JSON value. */
const fixture = stateFixture('regexp-bigint-flags', 'RegExpBigIntFlags');

/** A RegExp source forbids every flags argument whose value is proven defined. */
describe('defined primitive RegExp.compile flags', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '/x/.compile(/a/ as never,1n as never)',
    '/x/.compile(/a/ as never,-1n as never)',
    '/x/.compile(/a/ as never,~1n as never)',
    '(()=>{const flags=1n;return /x/.compile(/a/ as never,flags as never);})()',
    '/x/.compile(/a/ as never,false as never)',
    '/x/.compile(/a/ as never,true as never)',
    'RegExp.prototype.compile.call(/x/,/a/ as never,1n as never)',
    'Reflect.apply(RegExp.prototype.compile,/x/,[/a/,1n])',
  ])('refuses a source-written defined flags value: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '/x/.compile(/a/)',
    '/x/.compile(/a/ as never,undefined)',
    '/x/.compile(/a/ as never,void 0)',
    '(()=>{const flags=undefined;return /x/.compile(/a/ as never,flags);})()',
    "/x/.compile('a','g')",
    '({compile(_source:unknown,_flags:unknown){return first;}}).compile(/a/,1n)',
    '(()=>{try{return /x/.compile(/a/ as never,1n as never);}catch{return first;}})()',
    'false&&/x/.compile(/a/ as never,1n as never)',
    '(()=>/x/.compile(/a/ as never,1n as never))',
    '(()=>{const saved=RegExp.prototype.compile;try{return(RegExp.prototype.compile=(()=>first) as never,/x/.compile(/a/ as never,1n as never));}finally{RegExp.prototype.compile=saved;}})()',
  ])('keeps undefined flags and native evaluation boundaries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
