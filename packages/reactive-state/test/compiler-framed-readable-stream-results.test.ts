import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A closed native first queue chunk retains its original Error identity. */
const CASES = [
  {
    id: 'readable-first-error-chunk',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-first-caught-chunk',
    source:
      'async function frames(){try{JSON.parse("{");return "fixed";}catch(error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error as Error);controller.close();}});return (await stream.getReader().read()).value?.stack;}}',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-first-supplied-words',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}});return (await stream.getReader().read()).value?.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-fresh-native-frames',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(new Error("fixed"));controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-constructor-alias',
    source:
      'async function frames(error:Error){const Native=ReadableStream;const stream=new Native<Error>({start(controller){controller.enqueue(error);controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-stream-alias',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}});const saved=stream;return (await saved.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-computed-methods',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({["start"](controller){controller["enqueue"](error);controller["close"]();}});return (await stream["getReader"]()["read"]()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-start-function',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start:function(controller){controller.enqueue(error);controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-start-arrow',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start:controller=>{controller.enqueue(error);controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-callback-value-alias',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){const saved=error;controller.enqueue(saved);controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-open-queue',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-quiet-strategy',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}},{highWaterMark:1});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-immediate-construction',
    source:
      'async function frames(error:Error){return (await new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}}).getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-fixed-data-chunk',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<{stack:string}>({start(controller){controller.enqueue({stack:"fixed"});controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-local-error-words',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(new Error("fixed"));controller.close();}});return (await stream.getReader().read()).value?.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-later-error-not-first',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error|{stack:string}>({start(controller){controller.enqueue({stack:"fixed"});controller.enqueue(error);controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-callback-rewrite-after-enqueue',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);Object.assign(error,{stack:"fixed"});controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-callback-rewrite-before-enqueue',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){Object.assign(error,{stack:"fixed"});controller.enqueue(error);controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-enqueue-tail-effect',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){(controller.enqueue as(...args:unknown[])=>void)(error,Object.assign(error,{stack:"fixed"}));controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-strategy-size-effect',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}},{size(){Object.assign(error,{stack:"fixed"});return 1;}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-own-get-reader-data',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}});Object.defineProperty(stream,"getReader",{value(){return{async read(){return{value:{stack:"fixed"},done:false};}};}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-prior-callback-bridge',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){prepare();const stream=new ReadableStream<Error>({start(controller){controller.enqueue(value);controller.close();}});return (await stream.getReader().read()).value?.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-captured-error-owner',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){prepare();async function read(){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(value);controller.close();}});return (await stream.getReader().read()).value?.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-captured-stream-owner',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}});Object.assign(error,{stack:"fixed"});async function read(){return (await stream.getReader().read()).value?.stack;}return read();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-prior-fixed-stack',
    source:
      'async function frames(error:Error){Object.assign(error,{stack:"fixed"});const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-owner-default',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void,ignored=(prepare(),0)){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(value);controller.close();}});return (await stream.getReader().read()).value?.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-read-tail-effects',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}});return (await (stream.getReader().read as(...args:unknown[])=>Promise<ReadableStreamReadResult<Error>>)(Object.assign(error,{stack:"fixed"}))).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-stored-result-effects',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}});const result=await stream.getReader().read();Object.assign(error,{stack:"fixed"});return result.value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-start-default-effects',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller,ignored=Object.assign(error,{stack:"fixed"})){controller.enqueue(error);controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-async-start-effects',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({async start(controller){await Promise.resolve();Object.assign(error,{stack:"fixed"});controller.enqueue(error);controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-local-shadow-data',
    source:
      'async function frames(error:Error){class ReadableStream<T>{constructor(_source:{start(controller:{enqueue(value:T):void;close():void}):void}){}getReader(){return{async read(){return{value:{stack:"fixed",message:"fixed"}};}}}}const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}});return (await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-computed-start-name',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({["start"](controller){controller.enqueue(error);controller.close();}});return(await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'readable-source-computed-effect-data',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({[(Object.assign(error,{stack:"fixed"}),"start")](controller:ReadableStreamDefaultController<Error>){controller.enqueue(error);controller.close();}});return(await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-strategy-computed-effect-data',
    source:
      'async function frames(error:Error){const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}},{[(Object.assign(error,{stack:"fixed"}),"highWaterMark")]:1});return(await stream.getReader().read()).value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'readable-invalid-queue-limit-data',
    source:
      'async function frames(error:Error){try{const stream=new ReadableStream<Error>({start(controller){controller.enqueue(error);controller.close();}},{highWaterMark:-1});return(await stream.getReader().read()).value?.stack;}catch{return"fixed";}}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native readable stream readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'readable-stream.ts', source);
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

describe('native readable stream admissions', () => {
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
