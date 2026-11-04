import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Async find predicates retain possible parameter elements when exact endpoints are unavailable. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
  readonly files?: Readonly<Record<string, string>>;
}

const CASES: readonly Case[] = [
  {
    id: 'find-parameter-false',
    source: 'function frames(errors:Error[]){return errors.find(async()=>false)!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'find-last-parameter-false',
    source: 'function frames(errors:Error[]){return errors.findLast(async()=>false)!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'find-parameter-zero',
    source: 'function frames(errors:Error[]){return errors.find(async()=>0)!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'find-last-parameter-empty',
    source: 'function frames(errors:Error[]){return errors.findLast(async()=>"")!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'find-whole-constant-alias',
    source:
      'function frames(errors:Error[]){const input=errors;return input.find(async()=>false)!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'find-last-whole-alias',
    source:
      'function frames(errors:Error[]){const input=errors;return input.findLast(async()=>false)!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'find-computed-native-member',
    source: 'function frames(errors:Error[]){return errors["find"](async(value)=>false)!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'find-primitive-body-alias',
    source:
      'function frames(errors:Error[]){const keep=false;return errors.find(async()=>keep)!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'find-async-true-pin',
    source: 'function frames(errors:Error[]){return errors.find(async()=>true)!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'find-last-async-block-pin',
    source:
      'function frames(errors:Error[]){return errors.findLast(async()=>{return false;})!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'find-sync-false-pin',
    source: 'function frames(errors:Error[]){return errors.find(()=>false)?.stack??"fixed";}',
    invocation: 'frames([new Error("ours")])',
    refused: false,
  },
  {
    id: 'find-last-sync-false-pin',
    source: 'function frames(errors:Error[]){return errors.findLast(()=>false)?.stack??"fixed";}',
    invocation: 'frames([new Error("ours")])',
    refused: false,
  },
  {
    id: 'find-first-data-endpoint',
    source:
      'function frames(error:Error){return[{stack:"fixed"},error].find(async()=>false)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'find-last-data-endpoint',
    source:
      'function frames(error:Error){return[error,{stack:"fixed"}].findLast(async()=>false)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'find-first-hole-endpoint',
    source: 'function frames(error:Error){return[,error].find(async()=>false)?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'find-last-hole-endpoint',
    source:
      'function frames(error:Error){return[error,,].findLast(async()=>false)?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'find-ignored-tail-data',
    source:
      'function frames(errors:Error[]){return errors.find(async()=>false,Object.assign(errors[0]!,{stack:"fixed"}))!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: false,
  },
  {
    id: 'find-last-ignored-tail-data',
    source:
      'function frames(errors:Error[]){return errors.findLast(async()=>false,Object.assign(errors[0]!,{stack:"fixed"}))!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: false,
  },
  {
    id: 'find-owner-prefix-data',
    source:
      'function frames(error:Error){function collect(errors:Error[],prepare:()=>void){prepare();return errors.find(async()=>false)!.stack;}return collect([error],()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'find-getter-bridge-data',
    source:
      'function frames(error:Error){function collect(input:{errors:Error[]}){return input.errors.find(async()=>false)!.stack;}return collect({get errors(){Object.assign(error,{stack:"fixed"});return[error];}});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'find-receiver-iife-data',
    source:
      'function frames(error:Error){return(()=>{Object.assign(error,{stack:"fixed"});return[error];})().find(async()=>false)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'find-written-getter-data',
    source:
      'function frames(error:Error){const holder={get errors(){Object.assign(error,{stack:"fixed"});return[error];}};return holder.errors.find(async()=>false)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'find-captured-receiver-data',
    source:
      'function frames(error:Error){const errors=[error];function collect(){return errors.find(async()=>false)!.stack;}Object.assign(error,{stack:"fixed"});return collect();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'find-owner-default-data',
    source:
      'function frames(_error:Error,errors:Error[]=[]){return errors.find(async()=>false)?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'find-callback-default-data',
    source:
      'function frames(errors:Error[]){return errors.find(async(value:Error=new Error("fixed"))=>false)?.stack??"fixed";}',
    invocation: 'frames([undefined as unknown as Error])',
    refused: false,
  },
  {
    id: 'find-callback-getter-data',
    source:
      'function frames(errors:(Error&{marker:number})[]){return errors.find(async({marker})=>false)!.stack;}',
    invocation:
      '(()=>{const error=new Error("ours")as Error&{marker:number};Object.defineProperty(error,"marker",{get(){Object.assign(error,{stack:"fixed"});return 1;}});return frames([error]);})()',
    refused: false,
  },
  {
    id: 'find-opaque-tail-iterator',
    source:
      'function frames(errors:Error[],tail:unknown[]){return(errors.find as(...args:unknown[])=>Error)(async()=>false,...tail).stack;}',
    invocation:
      '(()=>{const error=new Error("ours");const tail:unknown[]=[];Object.assign(tail,{[Symbol.iterator]:function*(){Object.assign(error,{stack:"fixed"});yield 0;}});return frames([error],tail);})()',
    refused: false,
  },
  {
    id: 'find-saved-result-data',
    source:
      'function frames(errors:Error[]){const found=errors.find(async()=>false);Object.assign(found??{},{stack:"fixed"});return found?.stack??"fixed";}',
    invocation: 'frames([new Error("ours")])',
    refused: false,
  },
];

describe('async find fallback readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'find-fallback.ts', source);
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

describe('shared async find fallback admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, files }) => {
    const app = await application({
      ...files,
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
