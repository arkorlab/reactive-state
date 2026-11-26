import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A closed native encoder channel retains converted Error words. */
const CASES = [
  {
    id: 'encoder-stream-direct',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(error as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-caught',
    source:
      'async function frames(){try{JSON.parse("{");return "fixed";}catch(error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(error as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}}',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-writer-alias',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const saved=writer;const pending=saved.write(error as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-constructor-alias',
    source:
      'async function frames(error:Error){const Native=TextEncoderStream;const stream=new Native();const writer=stream.writable.getWriter();const pending=writer.write(error as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-bracket',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer["write"](error as never);const read=await stream["readable"]["getReader"]()["read"]();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-native-call',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=WritableStreamDefaultWriter.prototype.write.call(writer,error);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-native-apply',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=WritableStreamDefaultWriter.prototype.write.apply(writer,[error]);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-native-reflect',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=Reflect.apply(WritableStreamDefaultWriter.prototype.write,writer,[error]);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-array-words',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write([error] as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-finite-arguments',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(...[error as never] as const);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-reader-alias',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const reader=stream.readable.getReader();const pending=writer.write(error as never);const read=await reader.read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-directive',
    source:
      'async function frames(error:Error){"use strict";const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(error as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-ignored-constructor-literal',
    source:
      'async function frames(error:Error){const Native=TextEncoderStream as new(...args:unknown[])=>TextEncoderStream;const stream=new Native(0);const writer=stream.writable.getWriter();const pending=writer.write(error as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'encoder-stream-fixed-chunk-data',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write("fixed");const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-local-error-data',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(new Error("fixed") as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-ignored-tail-data',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=(writer.write as (...args:unknown[])=>Promise<void>)("fixed",error);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-prior-conversion-data',
    source:
      'async function frames(error:Error){Object.defineProperty(error,"toString",{value:()=>"fixed"});const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(error as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-write-tail-effects-data',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=(writer.write as(...args:unknown[])=>Promise<void>)(error,Object.defineProperty(error,"toString",{value:()=>"fixed"}));const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-between-write-read-data',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(error as never);Object.defineProperty(error,"toString",{value:()=>"fixed"});const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-read-tail-effects-data',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(error as never);const read=await (stream.readable.getReader().read as(...args:unknown[])=>Promise<ReadableStreamReadResult<Uint8Array>>)(Object.defineProperty(error,"toString",{value:()=>"fixed"}));await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-own-write-data',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const saved=writer.write;writer.write=()=>saved.call(writer,"fixed");const pending=writer.write(error as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-own-write-getter-data',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const saved=writer.write;Object.defineProperty(writer,"write",{get(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return(value:string)=>saved.call(writer,value);}});const pending=writer.write(error as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-own-reader-getter-data',
    source:
      'async function frames(error:Error){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();Object.defineProperty(stream.readable,"getReader",{value(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return ReadableStream.prototype.getReader.call(stream.readable);}});const pending=writer.write(error as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-ignored-constructor-effect-data',
    source:
      'async function frames(error:Error){const Native=TextEncoderStream as new(...args:unknown[])=>TextEncoderStream;const stream=new Native(Object.defineProperty(error,"toString",{value:()=>"fixed"}));const writer=stream.writable.getWriter();const pending=writer.write(error as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-local-shadow-data',
    source:
      'async function frames(error:Error){class TextEncoderStream{writable={getWriter(){return{async write(_value:unknown){}}}};readable={getReader(){return{async read(){return{value:new TextEncoder().encode("fixed")}}}}};}const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(error as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-prior-callback-data',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){prepare();const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(value as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-prior-member-data',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:{ready:unknown}){prepare.ready;const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(value as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}return collect(error,{get ready(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return 0;}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-owner-default-data',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void,ignored=(prepare(),0)){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(value as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'encoder-stream-captured-owner-data',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){prepare();async function read(){const stream=new TextEncoderStream();const writer=stream.writable.getWriter();const pending=writer.write(value as never);const read=await stream.readable.getReader().read();await pending;return new TextDecoder().decode(read.value);}return read();}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native encoder stream readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'encoder-stream.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('native encoder stream admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
