import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A directly invoked literal method keeps its original quiet receiver. */
const CASES = [
  {
    id: 'group-captured-error',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy([0],()=>error as never)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-caught-error',
    source:
      'function frames(){try{JSON.parse("{");return "fixed";}catch(error){return Object.keys(Object.groupBy([0],()=>error as never)).join();}}',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'group-function-expression',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy([0],function(){return error as never;})).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-named-function',
    source:
      'function frames(error:Error){function select(){return error as never;}return Object.keys(Object.groupBy([0],select)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-const-function-alias',
    source:
      'function frames(error:Error){const select=()=>error as never;return Object.keys(Object.groupBy([0],select)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-const-value-alias',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy([0],()=>{const chosen=error;return chosen as never;})).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-array-key-words',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy([0],()=>[error] as never)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-native-function-alias',
    source:
      'function frames(error:Error){const group=Object.groupBy;return Object.keys(group([0],()=>error as never)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-literal-input-spread',
    source:
      'function frames(error:Error){const values=[0] as const;return Object.keys(Object.groupBy([...values],()=>error as never)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-finite-arguments',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy(...[[0],()=>error as never] as const)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-two-elements',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy([0,1],()=>error as never)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-directive',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy([0],function(){"use strict";return error as never;})).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-fixed-key-data',
    source: 'function frames(){return Object.keys(Object.groupBy([0],()=>"fixed")).join();}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
  {
    id: 'group-local-error-words-data',
    source:
      'function frames(){return Object.keys(Object.groupBy([0],()=>new Error("fixed") as never)).join();}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
  {
    id: 'group-empty-input-data',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy([],()=>error as never)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-empty-spread-input-data',
    source:
      'function frames(error:Error){const empty=[] as const;return Object.keys(Object.groupBy([...empty],()=>error as never)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-own-conversion-data',
    source:
      'function frames(error:Error){Object.defineProperty(error,"toString",{value:()=>"fixed"});return Object.keys(Object.groupBy([0],()=>error as never)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-ignored-argument-data',
    source:
      'function frames(error:Error){return Object.keys((Object.groupBy as (...args:unknown[])=>Record<string,unknown[]>)([0],()=>error,Object.defineProperty(error,"toString",{value:()=>"fixed"}))).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-callback-default-data',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy([undefined],(_value:unknown=Object.defineProperty(error,"toString",{value:()=>"fixed"}))=>error as never)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-callback-prefix-data',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy([0],()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});return error as never;})).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-input-evaluation-data',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy([Object.defineProperty(error,"toString",{value:()=>"fixed"})],()=>error as never)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-computed-callee-data',
    source:
      'function frames(error:Error){return Object.keys(Object[(Object.defineProperty(error,"toString",{value:()=>"fixed"}),"groupBy")]([0],()=>error as never)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: true,
  },
  {
    id: 'group-replaced-callback-data',
    source:
      'function frames(error:Error){let select:()=>PropertyKey=()=>error as never;select=()=>"fixed";return Object.keys(Object.groupBy([0],select)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-async-callback-data',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy([0],(async()=>error) as unknown as()=>PropertyKey)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-generator-callback-data',
    source:
      'function frames(error:Error){return Object.keys(Object.groupBy([0],(function*(){return error;}) as unknown as()=>PropertyKey)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-map-identity-data',
    source: 'function frames(error:Error){return Map.groupBy([0],()=>error).size;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-local-object-data',
    source:
      'function frames(error:Error){const Object={groupBy(_input:unknown,_key:unknown){return {fixed:[0]};}};return Reflect.ownKeys(Object.groupBy([0],()=>error)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-replaced-named-callback-data',
    source:
      'function frames(error:Error){function select(){return error as never;}(select as ()=>PropertyKey)=()=>"fixed";return Object.keys(Object.groupBy([0],select)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-captured-named-callback-write-data',
    source:
      'function frames(error:Error){function select(){return error as never;}function change(){(select as ()=>PropertyKey)=()=>"fixed";}change();return Object.keys(Object.groupBy([0],select)).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-owner-prior-callback-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return Object.keys(Object.groupBy([0],()=>value as never)).join(",");}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-owner-prior-member-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{ready:unknown}){prepare.ready;return Object.keys(Object.groupBy([0],()=>value as never)).join(",");}return collect(error,{get ready(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return 0;}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-owner-prior-keys-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:Record<string,unknown>){Reflect.ownKeys(prepare);return Object.keys(Object.groupBy([0],()=>value as never)).join(",");}return collect(error,new Proxy({},{ownKeys(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return [];}}));}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-owner-default-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,ignored=(prepare(),0)){return Object.keys(Object.groupBy([0],()=>value as never)).join(",");}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-captured-owner-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return Object.keys(Object.groupBy([0],()=>value as never)).join(",");}return read();}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-quiet-owner-constant',
    source:
      'function frames(error:Error){const label="fixed";return Object.keys(Object.groupBy([label],()=>error as never)).join(",");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-deferred-body',
    source:
      'function frames(error:Error){function untouched(){Object.defineProperty(error,"toString",{value:()=>"fixed"});}return Object.keys(Object.groupBy([0],()=>error as never)).join(",");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'groupby-key-constructor-field-prefix-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){class Read{prepared=prepare();result:string;constructor(error:Error){this.result=Object.keys(Object.groupBy([0],()=>error as never)).join(",");}}return new Read(value).result;}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-callback-parameter-alias-data',
    source:
      'function frames(){const select=(value:Error)=>{const chosen=value;return chosen as never;};return Object.keys(Object.groupBy([0],select as unknown as (value:number)=>PropertyKey)).join(",");}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
] as const;

describe('literal method this readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'groupby-keys.ts', source);
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

describe('literal method this admissions', () => {
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
