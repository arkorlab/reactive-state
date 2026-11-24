import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The prop branch discards the protocol result before the authority starts its JSON state. */
const fixture = stateFixture('string-protocols', 'StringProtocols');

/** Source-written string protocols run only the final selected own descriptor. */
describe('written string protocol callbacks', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '"x".match({[Symbol.match](){throw new Error("match");}} as any)',
    '"x".matchAll({[Symbol.matchAll](){throw new Error("matchAll");}} as any)',
    '"x".replace({[Symbol.replace](){throw new Error("replace");}} as any,"z")',
    '"x".replaceAll({[Symbol.replace](){throw new Error("replaceAll");}} as any,"z")',
    '"x".search({[Symbol.search](){throw new Error("search");}} as any)',
    '"x".split({[Symbol.split](){throw new Error("split");}} as any)',
    '"x".match({get [Symbol.match](){throw new Error("getter");}} as any)',
    '"x".match({get [Symbol.match](){throw new Error("getter");},set [Symbol.match](_next:unknown){}} as any)',
    '"x".match({[globalThis.Symbol.match](){throw new Error("global");}} as any)',
    '(()=>{const key=Symbol.match;const pattern={[key](){throw new Error("alias");}};return "x".match(pattern as any);})()',
    '"x".match({[Symbol.match]:1} as any)',
    '"x".split({[Symbol.split]:{}} as any)',
    '"x".matchAll({get [Symbol.match](){throw new Error("before hook");},[Symbol.matchAll](){return [];}} as any)',
  ])('refuses a selected string protocol failure: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '"x".match({[Symbol.match](){return first;}} as any)',
    '"x".match({[Symbol.match](){throw new Error("overwritten");},[Symbol.match](){return first;}} as any)',
    '"x".match({get [Symbol.match](){throw new Error("overwritten");},[Symbol.match]:()=>first} as any)',
    '"x".match({[Symbol.match]:null,toString(){return "x";}} as any)',
    '"x".match({set [Symbol.match](_next:unknown){},toString(){return "x";}} as any)',
    '"x".match({[Symbol.match]:async()=>{throw new Error("deferred");}} as any)',
    '"x".match({[Symbol.match]:function*(){throw new Error("deferred");}} as any)',
    '(()=>{try{"x".match({[Symbol.match](){throw new Error("caught");}} as any);}catch{}return first;})()',
    'false&&"x".match({[Symbol.match](){throw new Error("skipped");}} as any)',
    '(()=>{const pattern:any={[Symbol.match](){throw new Error("changed");}};pattern[Symbol.match]=()=>first;return "x".match(pattern);})()',
    '(()=>{const pattern:any={[Symbol.match](){throw new Error("comma changed");}};return (pattern[Symbol.match]=()=>first,"x".match(pattern));})()',
    '"x".match({[Symbol.for(first)](){throw new Error("unknown key");},toString(){return "x";}} as any)',
    '({match(_pattern:unknown){return first;}}).match({[Symbol.match](){throw new Error("unused");}})',
    '(()=>{const original=String.prototype.match;try{String.prototype.match=(()=>null) as never;return "x".match({[Symbol.match](){throw new Error("unused");}} as any);}finally{String.prototype.match=original;}})()',
    '(()=>{const pattern:any={[Symbol.replace](){throw new Error("changed");}};return "x".replace(pattern,(pattern[Symbol.replace]=()=>first));})()',
    '(()=>{const pattern:any={get [Symbol.match](){pattern[Symbol.matchAll]=()=>[];return false;},[Symbol.matchAll](){throw new Error("changed");}};return "x".matchAll(pattern);})()',
  ])('keeps overwritten, unknown, deferred and handled protocols: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
