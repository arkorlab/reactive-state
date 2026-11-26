import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Quiet finite native Array.from mappers retain original selected Error results. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'identity-review-frames',
    source: 'function frames(error:Error){return Array.from([error],value=>value)[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'identity-supplied-words',
    source: 'function frames(error:Error){return Array.from([error],value=>value)[0]!.message;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'function-identity',
    source:
      'function frames(error:Error){return Array.from([error],function(value){return value;})[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'const-mapper-identity',
    source:
      'function frames(error:Error){const select=(value:Error)=>value;return Array.from([error],select)[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'named-mapper-identity',
    source:
      'function frames(error:Error){function select(value:Error){return value;}return Array.from([error],select)[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'const-source-alias',
    source:
      'function frames(error:Error){const values=[error];return Array.from(values,value=>value)[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'const-native-alias',
    source:
      'function frames(error:Error){const copy=Array.from;return copy([error],value=>value)[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-native-and-index',
    source:
      'function frames(error:Error){return globalThis.Array["from"]([error],value=>value)["0"]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'callback-parentheses',
    source:
      'function frames(error:Error){return Array.from([error],value=>(((value as Error))))[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'mapper-second-unused-index',
    source:
      'function frames(error:Error){return Array.from([error],(value,_index)=>value)[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'closed-captured-error',
    source: 'function frames(error:Error){return Array.from([0],()=>error)[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'closed-fresh-error',
    source:
      'function frames(error:Error){return Array.from([0],()=>new Error("fixed"))[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fresh-error-own-words-pin',
    source:
      'function frames(error:Error){return Array.from([0],()=>new Error("fixed"))[0]!.message;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'literal-data-identity-pin',
    source:
      'function frames(error:Error){return Array.from([{stack:"fixed"}],value=>value)[0]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'literal-mapper-data-pin',
    source:
      'function frames(error:Error){return Array.from([error],()=>({stack:"fixed"}))[0]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'selected-later-data-pin',
    source:
      'function frames(error:Error){return Array.from([error,{stack:"fixed"}],value=>value)[1]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'mapper-index-data-pin',
    source:
      'function frames(error:Error){return String(Array.from([error],(_value,index)=>index)[0]);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'hole-first-data-pin',
    source:
      'function frames(error:Error){return Array.from([,error],value=>value)[0]?.stack??"fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-source-data-pin',
    source:
      'function frames(error:Error){return Array.from([]as Error[],()=>error)[0]?.stack??"fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'quiet-third-argument',
    source: 'function frames(error:Error){return Array.from([error],value=>value,0)[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'third-argument-repair-pin',
    source:
      'function frames(error:Error){return Array.from([error],value=>value,Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'mapper-body-repair-pin',
    source:
      'function frames(error:Error){return Array.from([error],value=>{Object.assign(value,{stack:"fixed"});return value;})[0]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'mapper-default-repair-pin',
    source:
      'function frames(error:Error){return Array.from([undefined]as(Error|undefined)[],(value=Object.assign(error,{stack:"fixed"}))=>value)[0]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'source-custom-iterator-pin',
    source:
      'function frames(error:Error){const values=[error];values[Symbol.iterator]=function*():Generator<Error,undefined,unknown>{yield{stack:"fixed"}as Error;return undefined;};return Array.from(values,value=>value)[0]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'source-earlier-write-pin',
    source:
      'function frames(error:Error){const values=[error];values[0]={stack:"fixed"}as Error;return Array.from(values,value=>value)[0]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'source-accessor-repair-pin',
    source:
      'function frames(error:Error){return Array.from({length:1,get 0(){Object.assign(error,{stack:"fixed"});return error;}},value=>value)[0]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'prior-error-field-repair-pin',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});return Array.from([error],value=>value)[0]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'selector-effect-repair-pin',
    source:
      'function frames(error:Error){return Array.from([error],value=>value)[(Object.assign(error,{stack:"fixed"}),0)]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'saved-result-identity',
    source:
      'function frames(error:Error){const values=Array.from([error],value=>value);return values[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'saved-result-write-pin',
    source:
      'function frames(error:Error){const values=Array.from([error],value=>value);values[0]={stack:"fixed"}as Error;return values[0]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-array-shadow-pin',
    source:
      'function frames(error:Error){const Array={from(_values:Error[],_mapper:(value:Error)=>Error){return[{stack:"fixed"}];}};return Array.from([error],value=>value)[0]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-prefix-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return Array.from([value],item=>item)[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,_prepare:()=>void){const unused=0;return Array.from([value],item=>item)[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'captured-owner-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return Array.from([value],item=>item)[0]!.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'owner-default-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){return Array.from([value],item=>item)[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-tail-repair-pin',
    source:
      'function frames(error:Error){return(Array.from as(...args:unknown[])=>any)([error],(value:Error)=>value,undefined,Object.assign(error,{stack:"fixed"}))[0].stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'zero-parameter-undefined-data',
    source:
      'function frames(error:Error){return Array.from([error],()=>undefined as unknown as {stack?:string}|undefined)[0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'zero-parameter-nan-data',
    source:
      'function frames(error:Error){return Array.from([error],()=>NaN as unknown as {stack?:string})[0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'zero-parameter-infinity-data',
    source:
      'function frames(error:Error){return Array.from([error],()=>Infinity as unknown as {stack?:string})[0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native Array.from mapper readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-array-from-mappers.ts', source);
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

describe('shared native Array.from mapper admissions', () => {
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
