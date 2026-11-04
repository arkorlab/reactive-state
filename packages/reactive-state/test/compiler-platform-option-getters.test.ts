import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The constructor executes before the authority receives a trailing JSON string. */
const fixture = stateFixture('platform-option-getters', 'PlatformOptionGetters');

/** Native constructor dictionaries consume getters synchronously, while callbacks retain their timing. */
describe('written native constructor option getters', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'new TextDecoder("utf-8",{get fatal(){throw new Error("bad");}})',
    'new TextDecoder("utf-8",{get ignoreBOM(){throw new Error("bad");}})',
    'new TextDecoderStream("utf-8",{get fatal(){throw new Error("bad");}})',
    'new ByteLengthQueuingStrategy({get highWaterMark(){throw new Error("bad");}})',
    'new CountQueuingStrategy({get highWaterMark(){throw new Error("bad");}})',
    'new ReadableStream(undefined,{get highWaterMark(){throw new Error("bad");}})',
    'new WritableStream(undefined,{get size(){throw new Error("bad");}})',
    'new TransformStream(undefined,{get highWaterMark(){throw new Error("bad");}})',
    'new TransformStream(undefined,undefined,{get size(){throw new Error("bad");}})',
    'new ReadableStream({get pull(){throw new Error("bad");}})',
    'new WritableStream({get write(){throw new Error("bad");}})',
    'new TransformStream({get transform(){throw new Error("bad");}})',
    '(()=>{const options={get fatal(){throw new Error("bad");}};return new TextDecoder("utf-8",options);})()',
  ])('refuses a consumed native dictionary getter: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    'new TextDecoder("utf-8",{get other(){throw new Error("unused");}})',
    'new TextDecoder("utf-8",{get fatal(){throw new Error("overwritten");},fatal:false})',
    'new TextDecoder("utf-8",{get fatal(){return false;},set fatal(value){void value;}})',
    'new TextDecoder("utf-8",{get fatal(){return Promise.resolve(false);}} as never)',
    'new ReadableStream({async start(){throw new Error("rejected");}})',
    'new ReadableStream({*start(){throw new Error("deferred");}})',
    'new WritableStream({async start(){throw new Error("rejected");}})',
    'new TransformStream({async start(){throw new Error("rejected");}})',
    'new ReadableStream(undefined,{get other(){throw new Error("unused");}})',
    'new ReadableStream({get autoAllocateChunkSize(){throw new Error("unused without bytes");}})',
    '(()=>{const options={get fatal(){Object.defineProperty(options,"ignoreBOM",{value:false});return false;},get ignoreBOM(){throw new Error("repaired");}};return new TextDecoder("utf-8",options);})()',
    '(()=>{const options={get fatal(){throw new Error("repaired");}};const label={toString(){Object.defineProperty(options,"fatal",{value:false});return "utf-8";}};return new TextDecoder(label as never,options);})()',
    '(()=>{const options={get fatal(){throw new Error("repaired");}};return new TextDecoder("utf-8",options,Object.defineProperty(options,"fatal",{value:false}));})()',
    '(()=>{const options={get fatal(){throw new Error("replaced");}};Object.defineProperty(options,"fatal",{value:false});return new TextDecoder("utf-8",options);})()',
    '(()=>{let Decoder=TextDecoder;Decoder=class {} as never;return new Decoder("utf-8",{get fatal(){throw new Error("unused");}});})()',
    '(()=>{try{return new TextDecoder("utf-8",{get fatal(){throw new Error("caught");}});}catch{return first;}})()',
    'false&&new TextDecoder("utf-8",{get fatal(){throw new Error("skipped");}})',
    '(()=>new TextDecoder("utf-8",{get fatal(){throw new Error("deferred");}}))',
    'new TextDecoder("utf-8",(first||{}) as never)',
    '(()=>{const Original=TextDecoder;try{globalThis.TextDecoder=class {} as never;return(()=>new TextDecoder("utf-8",{get fatal(){throw new Error("nested repair");}}))();}finally{globalThis.TextDecoder=Original;}})()',
  ])('keeps ignored options, repairs and deferred callback bodies: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
