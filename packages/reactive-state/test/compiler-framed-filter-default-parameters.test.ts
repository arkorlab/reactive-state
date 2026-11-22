import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native filter defaults retain exact compacted source slots when their evaluation is quiet or skipped. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'one-hole-default',
    source:
      'function frames(error:Error){return [,error].filter((value:Error|{stack:string}|undefined=undefined)=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'two-holes-default',
    source:
      'function frames(error:Error){return [,,error].filter((value:Error|{stack:string}|undefined=undefined)=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'hole-after-data-default',
    source:
      'function frames(error:Error){return [{stack:"fixed"},,error].filter((value:Error|{stack:string}|undefined=undefined)=>true)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'two-errors-default',
    source:
      'function frames(error:Error){return [,error,error].filter((value:Error|{stack:string}|undefined=undefined)=>true)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'explicit-undefined-default',
    source:
      'function frames(error:Error){return [undefined,error].filter((value:Error|{stack:string}|undefined=undefined)=>true)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'saved-sparse-default',
    source:
      'function frames(error:Error){const values=[,error];return values.filter((value:Error|undefined=undefined)=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-true-default',
    source:
      'function frames(error:Error){return [,error].filter(async(value:Error|undefined=undefined)=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'typed-binding-default',
    source:
      'function frames(error:Error){return [,error].filter((value:Error|undefined=undefined)=>!false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'dense-known-data-pin',
    source:
      'function frames(error:Error){return [error,{stack:"fixed"}].filter(()=>true)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-plain-error-pin',
    source: 'function frames(error:Error){return [,error].filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'dense-error-pin',
    source: 'function frames(error:Error){return [error].filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'false-sparse-pin',
    source: 'function frames(error:Error){return [,error].filter(()=>false)[0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'async-false-plain-pin',
    source: 'function frames(error:Error){return [,error].filter(async()=>false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-data-default-pin',
    source:
      'function frames(error:Error){return [,{stack:"fixed"}].filter((value:{stack:string}|undefined=undefined)=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-filter-pin',
    source:
      'function frames(error:Error){const values={filter(_callback:unknown){return [{stack:"fixed"}];}};return values.filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-default-reported-independent',
    source:
      'function frames(error:Error){return [,error].filter((value:Error|{stack:string}|undefined=(()=>undefined)())=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-default-data-then-error-0',
    source:
      'function frames(error:Error){return [,{stack:"fixed"},error].filter((value:Error|{stack:string}|undefined=(()=>undefined)())=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'call-default-data-then-error-1',
    source:
      'function frames(error:Error){return [,{stack:"fixed"},error].filter((value:Error|{stack:string}|undefined=(()=>undefined)())=>true)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'skipped-default-error-reference',
    source:
      'function frames(error:Error){return [,error].filter((value:Error=(()=>error)())=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'skipped-default-error-alias',
    source:
      'function frames(error:Error){const input=error;return [,input].filter((value:Error=(()=>error)())=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'provided-index-default',
    source:
      'function frames(error:Error){return [,error].filter((value,index:number=(()=>0)())=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'provided-index-default-error-reference',
    source:
      'function frames(error:Error){return [,error].filter((value,index:number=(()=>{void error;return 0;})())=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'provided-array-default-error-reference',
    source:
      'function frames(error:Error){return [,error].filter((value,index,values:readonly(Error|undefined)[]=(()=>[error])())=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'fourth-quiet-default-error-reference',
    source:
      'function frames(error:Error){return [,error].filter((value,index,values,extra:Error=error)=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-source-call-default',
    source:
      'function frames(error:Error){const values=[,error];return values.filter((value:Error|undefined=(()=>undefined)())=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-call-default',
    source:
      'function frames(error:Error){return Array.prototype.filter.call([,error],(value:Error|undefined=(()=>undefined)())=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-apply-default',
    source:
      'function frames(error:Error){return Array.prototype.filter.apply([,error],[(value:Error|undefined=(()=>undefined)())=>true])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reflect-apply-default',
    source:
      'function frames(error:Error){return Reflect.apply(Array.prototype.filter,[,error],[(value:Error|undefined=(()=>undefined)())=>true])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-false-call-default',
    source:
      'function frames(error:Error){return [,error].filter(async(value:Error|undefined=(()=>undefined)())=>false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-at-call-default',
    source:
      'function frames(error:Error){return [,error].filter((value:Error|undefined=(()=>undefined)())=>true).at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'dense-data-call-default',
    source:
      'function frames(error:Error){return [error,{stack:"fixed"}].filter((value:Error|{stack:string}|undefined=(()=>undefined)())=>true)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'explicit-undefined-quiet-error-default',
    source:
      'function frames(error:Error){return [,undefined,error].filter((value:Error=error)=>true)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'optional-input-quiet-default',
    source:
      'function frames(error?:Error){return [,error].filter((value:Error|undefined=undefined)=>true)[0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'quiet-default-data-then-error',
    source:
      'function frames(error:Error){return [,{stack:"fixed"},error].filter((value:Error|{stack:string}|undefined=undefined)=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native filter default parameter readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-filter-default-parameters.ts', source);
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

describe('shared native filter default parameter admissions', () => {
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
