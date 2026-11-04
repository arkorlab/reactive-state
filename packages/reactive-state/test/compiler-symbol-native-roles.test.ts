import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The native call executes before the authority receives a trailing JSON string. */
const fixture = stateFixture('symbol-native-roles', 'SymbolNativeRoles');

/** Symbols cannot serve as callbacks or receivers of String's own prototype methods. */
describe('written Symbol native callback and String receiver roles', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "[first].map(Symbol('callback') as never)",
    "[].map(Symbol('callback') as never)",
    "[first].reduce(Symbol('callback') as never,first)",
    "[].sort(Symbol('callback') as never)",
    "Array.from([],Symbol('callback') as never)",
    "(()=>{const callback=Symbol('callback');return [first].filter(callback as never);})()",
    "String.prototype.includes.call(Symbol('x') as never,'x')",
    "String.prototype.slice.apply(Symbol('x') as never,[])",
    "Reflect.apply(String.prototype.trim,Symbol('x'),[])",
    "String.prototype.toString.call(Symbol('x') as never)",
    "String.prototype.valueOf.call(Symbol('x') as never)",
    "(()=>{const value=Symbol('x');return String.prototype.charAt.call(value as never,0);})()",
  ])('refuses written Symbol callbacks and String receivers: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    "[first].map(()=>Symbol('result'))",
    '[].map(class {})',
    "({map(_callback:symbol){return first;}}).map(Symbol('callback'))",
    "(()=>{Array.prototype.map=(()=>[first]) as never;return [first].map(Symbol('callback') as never);})()",
    "String(Symbol('x'))",
    "String.prototype.constructor.call(Symbol('x'))",
    "String.prototype.isPrototypeOf.call(Symbol('x'))",
    "String.prototype.includes.call('text','x')",
    "(()=>{String.prototype.includes=(()=>true) as never;return String.prototype.includes.call(Symbol('x') as never,'x');})()",
    "(()=>{try{return String.prototype.includes.call(Symbol('x') as never,'x');}catch{return first;}})()",
    "false&&[first].map(Symbol('callback') as never)",
    "(()=>String.prototype.includes.call(Symbol('x') as never,'x'))",
  ])('keeps explicit, ignored, custom and deferred native inputs: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
