import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Single written parameter call results retain their original annotation and selected member path. */
const CASES = [
  {
    id: 'direct-parameter-result-error',
    source: 'function frames(make:()=>Error){return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias-parameter-result-error',
    source: 'type Maker=()=>Error;function frames(make:Maker){return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-alias-parameter-result-error',
    source: 'type Maker<T>=()=>T;function frames(make:Maker<Error>){return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-constant-callable-alias-error',
    source: 'function frames(make:()=>Error){const invoke=make;return invoke().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'two-constant-callable-aliases-error',
    source:
      'function frames(make:()=>Error){const saved=make;const invoke=saved;return invoke().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'destructured-parameter-result-error',
    source: 'function frames({make}:{make:()=>Error}){return make().stack;}',
    invocation: 'frames({make:()=>new Error("ours")})',
    refused: true,
  },
  {
    id: 'selected-result-field-error',
    source: 'function frames(make:()=>{failure:Error}){return make().failure.stack;}',
    invocation: 'frames(()=>({failure:new Error("ours")}))',
    refused: true,
  },
  {
    id: 'selected-result-tuple-error',
    source: 'function frames(make:()=>[{stack:string},Error]){return make()[1].stack;}',
    invocation: 'frames(()=>[{stack:"fixed"},new Error("ours")])',
    refused: true,
  },
  {
    id: 'result-type-alias-error',
    source: 'type Failure=Error;function frames(make:()=>Failure){return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'written-call-signature-error',
    source: 'function frames(make:{():Error}){return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'interface-call-signature-error',
    source: 'interface Maker{():Error}function frames(make:Maker){return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-interface-call-signature-error',
    source: 'interface Maker<T>{():T}function frames(make:Maker<Error>){return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-call-signature-error',
    source:
      'interface Base<T>{():T}interface Maker<T>extends Base<T>{}function frames(make:Maker<Error>){return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'single-intersection-call-signature-error',
    source:
      'type Maker=(()=>Error)&{tag?:string};function frames(make:Maker){return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'union-callable-result-error',
    source:
      'type Maker=(()=>Error)|(()=>{stack:string});function frames(make:Maker){return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'false-assignment-keeps-parameter-error',
    source:
      'function frames(make:()=>Error){if(false)make=()=>({name:"Fixed",message:"fixed",stack:"fixed"});return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'later-assignment-keeps-earlier-error',
    source:
      'function frames(make:()=>Error){const stack=make().stack;make=()=>({name:"Fixed",message:"fixed",stack:"fixed"});return stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'captured-callable-before-rebind-error',
    source:
      'function frames(make:()=>Error){const invoke=make;make=()=>({name:"Fixed",message:"fixed",stack:"fixed"});return invoke().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'direct-parameter-data-pin',
    source: 'function frames(make:()=>{stack:string}){return make().stack;}',
    invocation: 'frames(()=>({stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'generic-alias-parameter-data-pin',
    source: 'type Maker<T>=()=>T;function frames(make:Maker<{stack:string}>){return make().stack;}',
    invocation: 'frames(()=>({stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'source-body-data-pin',
    source:
      'function frames(){const make:()=>Error=()=>({name:"Fixed",message:"fixed",stack:"fixed"});return make().stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'parameter-reassignment-data-pin',
    source:
      'function frames(make:()=>Error){make=()=>({name:"Fixed",message:"fixed",stack:"fixed"});return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: false,
  },
  {
    id: 'alias-after-reassignment-data-pin',
    source:
      'function frames(make:()=>Error){make=()=>({name:"Fixed",message:"fixed",stack:"fixed"});const invoke=make;return invoke().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: false,
  },
  {
    id: 'lexical-callable-shadow-data-pin',
    source:
      'function frames(make:()=>Error){function selected(make:()=>{stack:string}){return make().stack;}return selected(()=>({stack:"fixed"}));}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: false,
  },
  {
    id: 'opaque-native-callable-query-data-pin',
    source: 'function frames(make:typeof JSON.parse){return make(\'{"stack":"fixed"}\').stack;}',
    invocation: 'frames(JSON.parse)',
    refused: false,
  },
  {
    id: 'unresolved-overload-data-pin',
    source:
      'type Maker={(kind:"error"):Error;(kind:"data"):{stack:string}};function frames(make:Maker){return make("data").stack;}',
    invocation: 'frames((()=>({name:"Fixed",message:"fixed",stack:"fixed"})) as Maker)',
    refused: false,
  },
  {
    id: 'unresolved-generic-call-data-pin',
    source: 'function frames(make:<T>(value:T)=>T){return make({stack:"fixed"}).stack;}',
    invocation: 'frames(value=>value)',
    refused: false,
  },
  {
    id: 'constrained-generic-call-data-pin',
    source:
      'function frames(make:<T extends{stack:string}>(value:T)=>T){return make({stack:"fixed"}).stack;}',
    invocation: 'frames(value=>value)',
    refused: false,
  },
  {
    id: 'source-default-data-pin',
    source:
      'function frames(make:()=>Error=()=>({name:"Fixed",message:"fixed",stack:"fixed"})){return make().stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'own-callable-field-data-pin',
    source:
      'function frames(holder:{make:()=>Error}){holder.make=()=>({name:"Fixed",message:"fixed",stack:"fixed"});return holder.make().stack;}',
    invocation: 'frames({make:()=>new Error("ours")})',
    refused: false,
  },
  {
    id: 'shadow-error-result-data-pin',
    source: 'type Error={stack:string};function frames(make:()=>Error){return make().stack;}',
    invocation: 'frames(()=>({stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'unselected-result-field-data-pin',
    source:
      'function frames(make:()=>{failure:Error,data:{stack:string}}){return make().data.stack;}',
    invocation: 'frames(()=>({failure:new Error("ours"),data:{stack:"fixed"}}))',
    refused: false,
  },
  {
    id: 'destructured-callable-data-pin',
    source: 'function frames({make}:{make:()=>{stack:string}}){return make().stack;}',
    invocation: 'frames({make:()=>({stack:"fixed"})})',
    refused: false,
  },
  {
    id: 'dom-exception-call-result-error',
    source: 'function frames(make:()=>DOMException){return make().stack;}',
    invocation: 'frames(()=>new DOMException("ours"))',
    refused: true,
  },
  {
    id: 'aggregate-call-result-error',
    source: 'function frames(make:()=>AggregateError){return make().stack;}',
    invocation: 'frames(()=>new AggregateError([],"ours"))',
    refused: true,
  },
  {
    id: 'computed-return-key-order-data-pin',
    source:
      'function frames(make:()=>{failure:Error},error:Error){return make()[(Object.assign(error,{stack:"fixed"}),"failure")].stack;}',
    invocation:
      '(()=>{const error=new Error("ours");return frames(()=>({failure:error}),error);})()',
    refused: false,
  },
  {
    id: 'literal-return-key-error',
    source: 'function frames(make:()=>{failure:Error}){return make()["failure"].stack;}',
    invocation: 'frames(()=>({failure:new Error("ours")}))',
    refused: true,
  },
  {
    id: 'effectful-ignored-argument-data-pin',
    source:
      'function frames(make:()=>Error,error:Error){return(make as(...args:unknown[])=>Error)(Object.assign(error,{stack:"fixed"})).stack;}',
    invocation: '(()=>{const error=new Error("ours");return frames(()=>error,error);})()',
    refused: false,
  },
  {
    id: 'quiet-ignored-argument-error',
    source: 'function frames(make:()=>Error){return(make as(...args:unknown[])=>Error)(0).stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-error-constraint-data-pin',
    source:
      'function frames(make:<T extends Error>(value:T)=>T){return make({name:"Fixed",message:"fixed",stack:"fixed"}).stack;}',
    invocation: 'frames(value=>value)',
    refused: false,
  },
  {
    id: 'generic-error-member-constraint-data-pin',
    source:
      'function frames(make:<T extends Error>(value:T)=>{selected:T}){return make({name:"Fixed",message:"fixed",stack:"fixed"}).selected.stack;}',
    invocation: 'frames(value=>({selected:value}))',
    refused: false,
  },
  {
    id: 'generic-object-call-signature-data-pin',
    source:
      'function frames(make:{<T extends Error>(value:T):T}){return make({name:"Fixed",message:"fixed",stack:"fixed"}).stack;}',
    invocation: 'frames(value=>value)',
    refused: false,
  },
  {
    id: 'generic-interface-call-signature-data-pin',
    source:
      'interface Maker{<T extends Error>(value:T):{selected:T}}function frames(make:Maker){return make({name:"Fixed",message:"fixed",stack:"fixed"}).selected.stack;}',
    invocation: 'frames(value=>({selected:value}))',
    refused: false,
  },
];

describe('typed parameter call readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'parameter-call-observations.ts', source);
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

describe('shared typed parameter call admissions', () => {
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
