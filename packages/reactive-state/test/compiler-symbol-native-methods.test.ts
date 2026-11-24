import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A native method consumes its numeric arguments before a discarded authority result. */
const fixture = stateFixture('symbol-native-methods', 'SymbolNativeMethods');

/** Primitive Symbols cannot undergo the source-proven native ToNumber argument conversions. */
describe('written Symbol numeric native method arguments', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "'xy'.slice(Symbol('index') as never)",
    "'xy'.substring(0,Symbol('end') as never)",
    "[1,2].slice(Symbol('start') as never)",
    "[1,2].at(Symbol('index') as never)",
    "new Uint8Array([1,2]).slice(Symbol('start') as never)",
    "new Uint8Array(1).set([1],Symbol('offset') as never)",
    "new Date(0).setTime(Symbol('time') as never)",
    "new DataView(new ArrayBuffer(2)).getInt16(Symbol('offset') as never)",
    "new DataView(new ArrayBuffer(2)).setInt16(0,Symbol('value') as never)",
    "String.prototype.slice.call('xy',Symbol('start') as never)",
    "Array.prototype.at.apply([1],[Symbol('index')] as never)",
    "Reflect.apply(String.prototype.charAt,'xy',[Symbol('index')])",
  ])('refuses a consumed Symbol numeric argument: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "'xy'.slice(1,2)",
    "('xy'.slice as Function)(1,2,Symbol('ignored'))",
    "[1].fill(Symbol('value') as never)",
    "[1].indexOf(Symbol('searched') as never)",
    "[].includes(0 as never,Symbol('ignored') as never)",
    "new Uint8Array(0).includes(0,Symbol('ignored') as never)",
    "new DataView(new ArrayBuffer(2)).getInt16(0,Symbol('endian') as never)",
    "(new Date(0).setTime as Function)(0,Symbol('ignored'))",
    "({slice(_index:unknown){return first;}}).slice(Symbol('custom'))",
    "(()=>{const values=[1,2];values.slice=(()=>[]) as never;return values.slice(Symbol('custom') as never);})()",
    "(()=>{const saved=String.prototype.slice;try{String.prototype.slice=(()=>first) as never;return(()=> 'xy'.slice(Symbol('unused') as never))();}finally{String.prototype.slice=saved;}})()",
    "(()=>{const saved=Symbol;try{globalThis.Symbol=Object.setPrototypeOf((()=>0) as never,saved);return 'xy'.slice(Symbol('index') as never);}finally{globalThis.Symbol=saved;}})()",
    "(()=>{function read(index:unknown){return 'xy'.slice(index as never);}return read(0);})()",
    "(()=>{try{return 'xy'.slice(Symbol('caught') as never);}catch{return first;}})()",
    "false&&'xy'.slice(Symbol('skipped') as never)",
    "(()=> 'xy'.slice(Symbol('deferred') as never))",
    "(()=>{const saved=Symbol;try{return [1].fill(Symbol({toString(){globalThis.Symbol=Object.setPrototypeOf((()=>0) as never,saved);return 'label';}} as never) as never,Symbol('start') as never);}finally{globalThis.Symbol=saved;}})()",
  ])('keeps ignored, nonnumeric and unproven argument conversions: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
