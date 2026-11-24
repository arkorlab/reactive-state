import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Synchronous native root revivers preserve only quiet, original Error return identities. */
const CASES = [
  {
    id: 'supplied-frames',
    source: 'function frames(error:Error){return JSON.parse("{}",()=>error).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'supplied-words',
    source: 'function frames(error:Error){return JSON.parse("{}",()=>error).message;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'caught-frames',
    source:
      'function frames(_error:Error){try{JSON.parse("{");}catch(caught){return JSON.parse("{}",()=>caught).stack;}return "";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'caught-words',
    source:
      'function frames(_error:Error){try{JSON.parse("{");}catch(caught){return JSON.parse("{}",()=>caught).message;}return "";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'inline-function',
    source:
      'function frames(error:Error){return JSON.parse("{}",function(){return error;}).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'const-reviver',
    source:
      'function frames(error:Error){const revive=()=>error;return JSON.parse("{}",revive).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'named-reviver',
    source:
      'function frames(error:Error){function revive(){return error;}return JSON.parse("{}",revive).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-alias',
    source:
      'function frames(error:Error){const parse=JSON.parse;return parse("{}",()=>error).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'global-computed',
    source:
      'function frames(error:Error){return globalThis.JSON["parse"]("{}",()=>error)["stack"];}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-source',
    source: 'function frames(error:Error){return JSON.parse("[1,2]",()=>error).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fresh-frames',
    source: 'function frames(_error:Error){return JSON.parse("{}",()=>new Error("fixed")).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fresh-words-pin',
    source:
      'function frames(_error:Error){return JSON.parse("{}",()=>new TypeError("fixed")).message;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'literal-data-pin',
    source: 'function frames(_error:Error){return JSON.parse("{}",()=>({stack:"fixed"})).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'plain-json-pin',
    source: String.raw`function frames(_error:Error){return JSON.parse("{\"stack\":\"fixed\"}").stack;}`,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'noncallable-pin',
    source: String.raw`function frames(_error:Error){return JSON.parse("{\"stack\":\"fixed\"}","ignored"as never).stack;}`,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-json-pin',
    source:
      'function frames(error:Error){const JSON={parse(_text:string,_revive:()=>Error){return{stack:"fixed"};}};return JSON.parse("{}",()=>error).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'callback-write-pin',
    source:
      'function frames(error:Error){return JSON.parse("{}",()=>{Object.assign(error,{stack:"fixed"});return error;}).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-tail-write-pin',
    source:
      'function frames(error:Error){return(JSON.parse as(...args:unknown[])=>any)("{}",()=>error,Object.assign(error,{stack:"fixed"})).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-prefix-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return JSON.parse("{}",()=>value).stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const unused=0;return JSON.parse("{}",()=>value).stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'captured-owner-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return JSON.parse("{}",()=>value).stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'default-prefix-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){return JSON.parse("{}",()=>value).stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'getter-prefix-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return JSON.parse("{}",()=>value).stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return"done";}});}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'parse-input-conversion-pin',
    source:
      'function frames(error:Error){const text={toString(){Object.assign(error,{stack:"fixed"});return"{}";}};return JSON.parse(text as never,()=>error).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'async-reviver-pin',
    source: 'function frames(error:Error){return JSON.parse("{}",async()=>error).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'generator-reviver-pin',
    source:
      'function frames(error:Error){return JSON.parse("{}",function*(){return error;}).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'root-parameter-data-pin',
    source: String.raw`function frames(_error:Error){return JSON.parse("{\"stack\":\"fixed\"}",(_key:string,value:unknown)=>value).stack;}`,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'replaced-reviver-pin',
    source:
      'function frames(error:Error){let revive=()=>error;revive=()=>({stack:"fixed"}as Error);return JSON.parse("{}",revive).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'prior-field-rewrite-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return JSON.parse("{}",()=>error).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('native JSON root reviver readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'json-root-reviver.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});

describe('shared native JSON root reviver admissions', () => {
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
