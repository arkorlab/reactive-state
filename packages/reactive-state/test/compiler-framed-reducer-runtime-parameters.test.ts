import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'explicit-this-accumulator-reported',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].reduce<{stack?:string}>(function(this:void,acc:{stack?:string}){return acc;},error).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'right-explicit-this-accumulator',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].reduceRight<{stack?:string}>(function(this:void,acc:{stack?:string}){return acc;},error).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'explicit-this-current-error',
    source:
      'function frames(error:Error){return[error].reduce<{stack?:string}>(function(this:void,_acc:{stack?:string},current:{stack?:string}){return current;},{stack:"fixed"}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'right-explicit-this-current-error',
    source:
      'function frames(error:Error){return[error].reduceRight<{stack?:string}>(function(this:void,_acc:{stack?:string},current:{stack?:string}){return current;},{stack:"fixed"}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'initial-data-keeps-data',
    source:
      'function frames(error:Error){return[error].reduce<{stack?:string}>(function(this:void,acc:{stack?:string}){return acc;},{stack:"fixed"}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'right-initial-data-keeps-data',
    source:
      'function frames(error:Error){return[error].reduceRight<{stack?:string}>(function(this:void,acc:{stack?:string}){return acc;},{stack:"fixed"}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'current-data-keeps-data',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].reduce<{stack?:string}>(function(this:void,_acc:{stack?:string},current:{stack?:string}){return current;},error).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'no-initial-forward-accumulator',
    source:
      'function frames(error:Error){return([error,{stack:"fixed"}]as {stack?:string}[]).reduce(function(this:void,acc:{stack?:string}){return acc;}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'no-initial-reverse-accumulator',
    source:
      'function frames(error:Error){return([{stack:"fixed"},error]as {stack?:string}[]).reduceRight(function(this:void,acc:{stack?:string}){return acc;}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'no-initial-forward-current',
    source:
      'function frames(error:Error){return([{stack:"fixed"},error]as {stack?:string}[]).reduce(function(this:void,_acc:{stack?:string},current:{stack?:string}){return current;}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'no-initial-reverse-current',
    source:
      'function frames(error:Error){return([error,{stack:"fixed"}]as {stack?:string}[]).reduceRight(function(this:void,_acc:{stack?:string},current:{stack?:string}){return current;}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'default-accumulator-error',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].reduce<{stack?:string}|undefined>(function(this:void,acc:{stack?:string}=error){return acc;},undefined)!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'default-current-error',
    source:
      'function frames(error:Error){return[undefined].reduce<{stack?:string}>(function(this:void,_acc:{stack?:string},current:{stack?:string}=error){return current;},{stack:"fixed"}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'written-accumulator-error',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].reduce<{stack?:string}>(function(this:void,acc:{stack?:string}){const ignored=(acc=error);return acc;},{stack:"fixed"}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-borrowed-this-accumulator',
    source:
      'function frames(error:Error){return(Array.prototype.reduce.call as(receiver:{stack?:string}[],callback:(acc:{stack?:string})=>{stack?:string},initial:{stack?:string})=>{stack?:string})([{stack:"fixed"}],function(this:void,acc:{stack?:string}){return acc;},error).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-spread-this-accumulator',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].reduce<{stack?:string}>(...([function(this:void,acc:{stack?:string}){return acc;},error]as const)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-spread-initial-data',
    source:
      'function frames(error:Error){return[error].reduce<{stack?:string}>(...([function(this:void,acc:{stack?:string}){return acc;},{stack:"fixed"}]as const)).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'no-this-marker-keeps-accumulator',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].reduce<{stack?:string}>((acc)=>acc,error).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ordinary-first-name-is-runtime',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].reduce<{stack?:string}>(function(thisArg:{stack?:string}){return thisArg;},error).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'explicit-this-no-value-parameters',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].reduce<{stack?:string}>(function(this:void){return error;},{stack:"fixed"}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-input-keeps-initial',
    source:
      'function frames(error:Error){return([]as {stack?:string}[]).reduce<{stack?:string}>(function(this:void,acc:{stack?:string}){return acc;},error).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'only-present-input-uncalled',
    source:
      'function frames(error:Error){return([,error]as {stack?:string}[]).reduce(function(this:void,acc:{stack?:string}){return acc;}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'runtime-index-is-data',
    source:
      'function frames(error:Error){return([error].reduce(function(this:void,_acc:number,_value:Error,index:number){return index;},0)as unknown as {stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-reduce-keeps-data',
    source:
      'function frames(error:Error){const values=[{stack:"fixed"}];values.reduce=()=>({stack:"fixed"})as never;return values.reduce<{stack?:string}>(function(this:void,acc:{stack?:string}){return acc;},error).stack;}',
    reader: false,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('runtime reducer parameters readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-reduce.ts', source);
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

describe('runtime reducer parameters shared', () => {
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
