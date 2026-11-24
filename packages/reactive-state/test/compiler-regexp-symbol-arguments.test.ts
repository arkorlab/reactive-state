import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** Native RegExp conversion precedes a discarded result in an authority-started state. */
const fixture = stateFixture('regexp-symbol-arguments', 'RegExpSymbolArguments');

/** RegExp converts primitive Symbol patterns and explicit flags to text in both invocation modes. */
describe('written RegExp Symbol arguments', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "RegExp(Symbol('bad') as never)",
    "new RegExp(Symbol('bad') as never)",
    "RegExp('a',Symbol('bad') as never)",
    "new RegExp('a',Symbol('bad') as never)",
    'RegExp(/a/,Symbol.iterator as never)',
    "(()=>{const marker=Symbol('bad');return new RegExp(marker as never);})()",
    "(()=>{const Pattern=RegExp;return Pattern(Symbol.for('bad') as never);})()",
    "RegExp.call(null,Symbol('bad') as never)",
    "RegExp.apply(null,['a',Symbol('bad') as never])",
    "Reflect.apply(RegExp,null,[Symbol('bad')])",
    "(()=>{const token=Symbol;return new RegExp('a',token('bad') as never);})()",
  ])('refuses a consumed primitive Symbol: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "RegExp('a','i')",
    "new RegExp('a','g')",
    'RegExp(/a/,undefined)',
    "(RegExp as Function)('a',undefined,Symbol('ignored'))",
    "new (RegExp as any)('a',undefined,Symbol('ignored'))",
    "RegExp(String(Symbol('description')))",
    "(()=>{function RegExp(_value:unknown){return first;}return RegExp(Symbol('raw'));})()",
    "(()=>{const saved=RegExp;try{globalThis.RegExp=(()=>first) as never;return (()=>RegExp(Symbol('raw') as never))();}finally{globalThis.RegExp=saved;}})()",
    "(()=>{const saved=RegExp;try{globalThis.RegExp=function(){return {};} as never;return new RegExp(Symbol('raw') as never);}finally{globalThis.RegExp=saved;}})()",
    "(()=>{const saved=Symbol;try{globalThis.Symbol=Object.setPrototypeOf((()=>'a') as never,saved);return RegExp(Symbol('text') as never);}finally{globalThis.Symbol=saved;}})()",
    "(()=>{const saved=Symbol;try{const ignored=Symbol({toString(){globalThis.Symbol=Object.setPrototypeOf((()=>'a') as never,saved);return 'label';}} as never);return RegExp(Symbol('text') as never);}finally{globalThis.Symbol=saved;}})()",
    "(()=>{const saved=Symbol;try{return RegExp((globalThis.Symbol=Object.setPrototypeOf((()=>'g') as never,saved),'a'),Symbol('flags') as never);}finally{globalThis.Symbol=saved;}})()",
    '(()=>{function run(value:unknown){return RegExp(value as never);}return run(first);})()',
    "(()=>{try{return RegExp(Symbol('caught') as never);}catch{return first;}})()",
    "false&&new RegExp(Symbol('skipped') as never)",
    "(()=>RegExp('a',Symbol('deferred') as never))",
  ])('keeps explicit text, ignored slots and changed native boundaries: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
