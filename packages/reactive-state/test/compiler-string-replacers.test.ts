import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The prop branch discards the replacement result before the authority starts its JSON state. */
const fixture = stateFixture('string-replacers', 'StringReplacers');

/** Written text matches invoke a replacement callback synchronously. */
describe('written string replacement callbacks', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '"a".replace("a",()=>{throw new Error("replacement");})',
    '"aba".replaceAll("a",()=>{throw new Error("replacement");})',
    '"".replace("",()=>{throw new Error("replacement");})',
    '"abc".replace("b",()=>decodeURIComponent("%"))',
    '(()=>{const search="a";const replacement=()=>{throw new Error("replacement");};return "a".replace(search,replacement);})()',
    '"a".replaceAll("",function(){throw new Error("replacement");})',
  ])('refuses a necessarily invoked throwing replacement: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '"a".replace("b",()=>{throw new Error("uncalled");})',
    '"".replaceAll("x",()=>{throw new Error("uncalled");})',
    'first.replace("a",()=>{throw new Error("uncertain");})',
    '"a".replace(first,()=>{throw new Error("uncertain");})',
    '"a".replace("a",async()=>{throw new Error("deferred");})',
    '"a".replace("a",function*(){throw new Error("deferred");})',
    '"a".replace("a",()=>first)',
    '(()=>{try{"a".replace("a",()=>{throw new Error("caught");});}catch{}return first;})()',
    'false&&"a".replace("a",()=>{throw new Error("uncalled");})',
    '({replace(..._args:unknown[]){return first;}}).replace("a",()=>{throw new Error("uncalled");})',
    '(()=>{const original=String.prototype.replace;try{String.prototype.replace=(()=>"ok") as never;return "a".replace("a",()=>{throw new Error("uncalled");});}finally{String.prototype.replace=original;}})()',
    '(()=>{const original=decodeURIComponent;try{return "a".replace("a",((_match:any,_offset:any,_text:any,extra=(globalThis.decodeURIComponent=()=>"ok"))=>decodeURIComponent("%")) as never);}finally{globalThis.decodeURIComponent=original;}})()',
    '(()=>{const original=decodeURIComponent;try{return ("a" as any).replace("a",()=>decodeURIComponent("%"),(globalThis.decodeURIComponent=()=>"ok"));}finally{globalThis.decodeURIComponent=original;}})()',
  ])(
    'keeps absent matches, unknown, deferred, changed and handled work: %s',
    async (expression) => {
      const app = await fixture(expression);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});
