import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native filter compacts holes and keeps truthy asynchronous predicate results. */
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
    id: 'hole-compaction-review',
    source: 'function frames(error:Error){return[,error].filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'hole-compaction-words',
    source: 'function frames(error:Error){return[,error].filter(()=>true)[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'two-holes',
    source: 'function frames(error:Error){return[,,error].filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'hole-data-then-error',
    source:
      'function frames(error:Error){return[,{stack:"fixed"},error].filter(()=>true)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'middle-hole',
    source:
      'function frames(error:Error){return[{stack:"fixed"},,error].filter(()=>true)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-source-alias',
    source:
      'function frames(error:Error){const input=[,error];return input.filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-source-alias-chain',
    source:
      'function frames(error:Error){const input=[,error];const alias=input;return alias.filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-call',
    source:
      'function frames(error:Error){return(Array.prototype.filter.call([,error],()=>true)as Error[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-apply',
    source:
      'function frames(error:Error){return(Array.prototype.filter.apply([,error],[()=>true])as Error[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reflect-apply',
    source:
      'function frames(error:Error){return(Reflect.apply(Array.prototype.filter,[,error],[()=>true])as Error[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-false-review',
    source: 'function frames(error:Error){return[error].filter(async()=>false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-zero',
    source: 'function frames(error:Error){return[error].filter(async()=>0)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-null',
    source: 'function frames(error:Error){return[error].filter(async()=>null)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-undefined',
    source: 'function frames(error:Error){return[error].filter(async()=>undefined)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-empty-text',
    source: 'function frames(error:Error){return[error].filter(async()=>"")[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-hole-false',
    source: 'function frames(error:Error){return[,error].filter(async()=>false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'hole-compacted-data',
    source:
      'function frames(error:Error){return[,error,{stack:"fixed"}].filter(()=>true)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'hole-excluded-error',
    source:
      'function frames(error:Error){return[,{stack:"fixed"},error].filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'hole-outside-result',
    source: 'function frames(error:Error){return[,error].filter(()=>true)[2]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'holes-only',
    source:
      'function frames(error:Error){return([,].filter(()=>true)as unknown as Error[])[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'synchronous-false-pin',
    source: 'function frames(error:Error){return[,error].filter(()=>false)[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'dense-selected-data-pin',
    source:
      'function frames(error:Error){return[error,{stack:"fixed"}].filter(()=>true)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'dense-error-pin',
    source: 'function frames(error:Error){return[error].filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-true-pin',
    source: 'function frames(error:Error){return[error].filter(async()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-block-false-pin',
    source:
      'function frames(error:Error){return[error].filter(async()=>{return false;})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-function-false-pin',
    source:
      'function frames(error:Error){return[error].filter(async function(){return false;})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-data-pin',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].filter(async()=>false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-filter-data-pin',
    source:
      'function frames(error:Error){const input:{stack?:string}[]=[error];input.filter=(()=>[{stack:"fixed"}])as typeof input.filter;return input.filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-filter-error-pin',
    source:
      'function frames(error:Error){const input:{stack?:string}[]=[{stack:"fixed"}];input.filter=(()=>[error])as typeof input.filter;return input.filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boundary-saved-result-field',
    source:
      'function frames(error:Error){const result=[,error].filter(()=>true);Object.assign(error,{stack:"fixed"});return result[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boundary-evaluated-tail',
    source:
      'function frames(error:Error){const input=[,error];return(input.filter as(...args:unknown[])=>Error[])(()=>true,Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-alias',
    source:
      'function frames(error:Error){const input=[error];return input.filter(async()=>false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-borrowed-call',
    source:
      'function frames(error:Error){return(Array.prototype.filter.call([error],async()=>false)as Error[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-plain-parameter',
    source: 'function frames(error:Error){return[error].filter(async(value)=>false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'hole-this-argument',
    source: 'function frames(error:Error){return[,error].filter(()=>true,{})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'hole-constant-predicate',
    source:
      'function frames(error:Error){const keep=true;return[,error].filter(()=>keep)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'hole-negated-predicate',
    source: 'function frames(error:Error){return[,error].filter(()=>!false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-selected-data-pin',
    source:
      'function frames(error:Error){return[error,{stack:"fixed"}].filter(async()=>false)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'async-block-data-pin',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].filter(async()=>{return false;})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'boundary-getter-hole',
    source:
      'function frames(error:Error){Object.defineProperty(error,"marker",{get(){Object.assign(error,{stack:"fixed"});return 0;}});return[,error].filter(({marker}:Error&{marker?:number}=error)=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boundary-getter-async',
    source:
      'function frames(error:Error){Object.defineProperty(error,"marker",{get(){Object.assign(error,{stack:"fixed"});return 0;}});return[error].filter(async({marker}:Error&{marker?:number}=error)=>false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boundary-earlier-captured-write',
    source:
      'function frames(error:Error){function prepare(){Object.assign(error,{stack:"fixed"});}prepare();return[,error].filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boundary-defined-stack',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return[,error].filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boundary-async-tail',
    source:
      'function frames(error:Error){return[error].filter(async()=>false,Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boundary-async-saved-result',
    source:
      'function frames(error:Error){const result=[error].filter(async()=>false);Object.assign(error,{stack:"fixed"});return result[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'filter-loop-condition-use',
    source:
      'function frames(error:Error){let result:unknown;let i=0;do{result=[,error].filter(()=>true)[0]!.stack;}while((void error,i++<1));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'filter-loop-condition-data',
    source:
      'function frames(error:Error){let result:unknown;let i=0;do{result=[,error,{stack:"fixed"}].filter(()=>true)[1]!.stack;}while((void error,i++<1));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-filter-loop-push',
    source:
      'function frames(error:Error){const values:(Error|undefined)[]=[,];let result:unknown;let i=0;do result=values.filter(()=>true)[0]?.stack;while((values.push(error),i++<1));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-filter-loop-push-data',
    source:
      'function frames(error:Error){const values:(Error|undefined)[]=[,];const spare:Error[]=[];let result:unknown;let i=0;do result=values.filter(()=>true)[0]?.stack;while((spare.push(error),i++<1));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'async-filter-loop-replace',
    source:
      'function frames(error:Error){const input:Array<{stack?:string}>=[{stack:"fixed"}];let result:unknown;let i=0;do result=input.filter(async()=>true)[0]!.stack;while((input[0]=error,i++<1));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-filter-loop-replace-data',
    source:
      'function frames(error:Error){const input:Array<{stack?:string}>=[{stack:"fixed"}];const spare:Array<{stack?:string}>=[];let result:unknown;let i=0;do result=input.filter(async()=>true)[0]!.stack;while((spare[0]=error,i++<1));return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native filter result readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'filter-results.ts', source);
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

describe('shared native filter result admissions', () => {
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
