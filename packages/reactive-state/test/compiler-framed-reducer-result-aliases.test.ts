import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
  readonly actualRefused?: boolean;
}
const CASES: readonly Case[] = [
  {
    id: 'reported-accumulator-alias',
    source:
      'function frames(error:Error){return [0].reduce((acc)=>{const result=acc;return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'right-accumulator-alias',
    source:
      'function frames(error:Error){return [0].reduceRight((acc)=>{const result=acc;return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-const-chain',
    source:
      'function frames(error:Error){return [0].reduce((acc)=>{const first=acc;const result=first;return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'asserted-const-alias',
    source:
      'function frames(error:Error){return [0].reduce((acc)=>{const result=(acc as Error);return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'annotated-const-alias',
    source:
      'function frames(error:Error){return [0].reduce((acc)=>{const result:Error=acc;return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'current-value-alias',
    source:
      'function frames(error:Error){return [error].reduce<Error|{stack:string}>((acc,current)=>{const result=current;return result;},{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'right-current-value-alias',
    source:
      'function frames(error:Error){return [error].reduceRight<Error|{stack:string}>((acc,current)=>{const result=current;return result;},{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'omitted-initial-alias',
    source:
      'function frames(error:Error){return [error,error].reduce((acc)=>{const result=acc;return result;}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'right-omitted-initial-alias',
    source:
      'function frames(error:Error){return [error,error].reduceRight((acc)=>{const result=acc;return result;}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'middle-current-retained',
    source:
      'function frames(error:Error){return [undefined,error,undefined].reduce((acc,current)=>{const result=acc;const next=current;return result??next;},undefined)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'branch-current-retained',
    source:
      'function frames(error:Error){return [error].reduce<Error|{stack:string}>((acc,current)=>{const result=acc;const next=current;return true?next:result;},{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-accumulator-alias',
    source:
      'function frames(error:Error){return [,0].reduce((acc)=>{const result=acc;return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'defaulted-accumulator-alias',
    source:
      'function frames(error:Error){return [0].reduce((acc:Error|undefined=error)=>{const result=acc;return result;},undefined)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'lexical-shadow-preserved',
    source:
      'function frames(error:Error){const acc={stack:"fixed"};return [0].reduce((acc)=>{const result=acc;return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-call-alias',
    source:
      'function frames(error:Error){const native:(this:number[],reducer:(acc:Error,current:number)=>Error,initial:Error)=>Error=Array.prototype.reduce;return native.call([0],(acc)=>{const result=acc;return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'native-apply-alias',
    source:
      'function frames(error:Error){const native:(this:number[],reducer:(acc:Error,current:number)=>Error,initial:Error)=>Error=Array.prototype.reduce;return native.apply([0],[(acc)=>{const result=acc;return result;},error]).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'existing-direct-accumulator-pin',
    source: 'function frames(error:Error){return [0].reduce((acc)=>{return acc;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-fixed-data',
    source:
      'function frames(error:Error){return [0].reduce((acc)=>{const result=acc;return result;},{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'ignored-input-data',
    source:
      'function frames(error:Error){return [0].reduce<Error|{stack:string}>((acc)=>{const result={stack:"fixed"};return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'current-last-data',
    source:
      'function frames(error:Error){return [error,{stack:"fixed"}].reduce((acc,current)=>{const result=current;return result;},{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'right-current-first-data',
    source:
      'function frames(error:Error){return [{stack:"fixed"},error].reduceRight((acc,current)=>{const result=current;return result;},{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'uncalled-empty-data',
    source:
      'function frames(error:Error){return ([] as number[]).reduce<Error|{stack:string}>((acc)=>{const result=error;return result;},{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'parameter-write-before-alias-boundary',
    source:
      'function frames(error:Error){return [0].reduce((acc)=>{acc={stack:"fixed"} as Error;const result=acc;return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'parameter-write-after-snapshot-boundary',
    source:
      'function frames(error:Error){return [0].reduce((acc)=>{const result=acc;acc={stack:"fixed"} as Error;return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unknown-work-before-alias-boundary',
    source:
      'function frames(error:Error){return [0].reduce((acc)=>{function prepare(){acc={stack:"fixed"} as Error;}prepare();const result=acc;return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'destructured-result-boundary',
    source:
      'function frames(error:Error){return [0].reduce((acc)=>{const {value:result}={value:acc};return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'mutable-result-data',
    source:
      'function frames(error:Error){return [0].reduce((acc)=>{let result=acc;result={stack:"fixed"} as Error;return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-reduce-keeps-data',
    source:
      'function frames(error:Error){const values=[0];values.reduce=(()=>({stack:"fixed"})) as unknown as typeof values.reduce;return (values.reduce((acc)=>{const result=acc;return result;},error) as Error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-alias-remains-promise',
    source:
      'async function frames(error:Error){const result=[0].reduce(async(acc)=>{const result=acc;return result;},Promise.resolve(error));return (await result).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'direct-native-call',
    source:
      'function frames(error:Error){return (Array.prototype.reduce as (this:number[],reducer:(acc:Error,current:number)=>Error,initial:Error)=>Error).call([0],(acc)=>{const result=acc;return result;},error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'direct-native-apply',
    source:
      'function frames(error:Error){return (Array.prototype.reduce as (this:number[],reducer:(acc:Error,current:number)=>Error,initial:Error)=>Error).apply([0],[(acc)=>{const result=acc;return result;},error]).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('native reducer frame readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'frame-pair.ts', source);
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

describe('native reducer shared admission', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, actualRefused = refused }) => {
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
    const expected = actualRefused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
