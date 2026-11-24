import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Written call and construct results retain independent types without inferring signature arguments. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'construct-error-result',
    source: 'function frames(Make:new()=>Error){return new Make().stack;}',
    invocation: 'frames(globalThis.Error)',
    refused: true,
  },
  {
    id: 'construct-const-parameter-alias',
    source: 'function frames(Make:new()=>Error){const Alias=Make;return new Alias().stack;}',
    invocation: 'frames(globalThis.Error)',
    refused: true,
  },
  {
    id: 'construct-interface-error',
    source:
      'interface MakeError{new():Error}function frames(Make:MakeError){return new Make().stack;}',
    invocation: 'frames(globalThis.Error)',
    refused: true,
  },
  {
    id: 'construct-alias-actual-error',
    source: 'type Maker<T>=new()=>T;function frames(Make:Maker<Error>){return new Make().stack;}',
    invocation: 'frames(globalThis.Error)',
    refused: true,
  },
  {
    id: 'construct-alias-default-error',
    source: 'type Maker<T=Error>=new()=>T;function frames(Make:Maker){return new Make().stack;}',
    invocation: 'frames(globalThis.Error)',
    refused: true,
  },
  {
    id: 'construct-destructured-parameter',
    source: 'function frames({Make}:{Make:new()=>Error}){return new Make().stack;}',
    invocation: 'frames({Make:globalThis.Error})',
    refused: true,
  },
  {
    id: 'construct-nested-error-member',
    source: 'function frames(Make:new()=>{failure:Error}){return new Make().failure.stack;}',
    invocation: 'frames(class{failure=new globalThis.Error("ours")})',
    refused: true,
  },
  {
    id: 'construct-data-pin',
    source: 'function frames(Make:new()=>{stack:string}){return new Make().stack;}',
    invocation: 'frames(class{stack="fixed"})',
    refused: false,
  },
  {
    id: 'construct-default-data-opacity',
    source:
      'class DataError{name="Error";message="fixed";stack="fixed"}function frames(Make:new()=>Error=DataError){return new Make().stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'construct-replaced-data-opacity',
    source:
      'class DataError{name="Error";message="fixed";stack="fixed"}function frames(Make:new()=>Error){Make=DataError;return new Make().stack;}',
    invocation: 'frames(globalThis.Error)',
    refused: true,
    reader: false,
  },
  {
    id: 'construct-overload-data-opacity',
    source:
      'interface Maker{new():Error;new(value:string):{stack:string}}function frames(Make:Maker){return new Make("fixed").stack;}',
    invocation: 'frames(class{stack="fixed"}as unknown as Maker)',
    refused: false,
  },
  {
    id: 'construct-generic-dependent-data-opacity',
    source:
      'function frames(Make:new<T extends Error>(value:T)=>T){return new Make({name:"Error",message:"fixed",stack:"fixed"}).stack;}',
    invocation:
      'frames(class{constructor(value:Error){return value}}as unknown as new<T extends Error>(value:T)=>T)',
    refused: false,
  },
  {
    id: 'generic-independent-error',
    source: 'function frames(make:<T>()=>Error){return make<string>().stack;}',
    invocation: 'frames(<T,>()=>new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-independent-constraint-error',
    source: 'function frames(make:<T extends Error>()=>Error){return make<Error>().stack;}',
    invocation: 'frames(<T extends Error>()=>new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-independent-interface-error',
    source: 'interface Maker{<T>():Error}function frames(make:Maker){return make<string>().stack;}',
    invocation: 'frames(<T,>()=>new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-independent-local-alias-error',
    source:
      'type Result=Error;type Maker=<T>()=>Result;function frames(make:Maker){return make<number>().stack;}',
    invocation: 'frames(<T,>()=>new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-independent-nested-error',
    source: 'function frames(make:<T>()=>{failure:Error}){return make<string>().failure.stack;}',
    invocation: 'frames(<T,>()=>({failure:new globalThis.Error("ours")}))',
    refused: true,
  },
  {
    id: 'generic-independent-data-pin',
    source: 'function frames(make:<T>()=>{stack:string}){return make<string>().stack;}',
    invocation: 'frames(<T,>()=>({stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'generic-independent-constraint-data-pin',
    source:
      'function frames(make:<T extends Error>()=>{stack:string}){return make<Error>().stack;}',
    invocation: 'frames(<T extends Error>()=>({stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'generic-error-constraint-data-pin',
    source:
      'function frames(make:<T extends Error>(value:T)=>T){return make({name:"Error",message:"fixed",stack:"fixed"}).stack;}',
    invocation: 'frames(value=>value)',
    refused: false,
  },
  {
    id: 'generic-error-member-constraint-data-pin',
    source:
      'function frames(make:<T extends {failure:Error}>(value:T)=>T){return make({failure:{name:"Error",message:"fixed",stack:"fixed"}}).failure.stack;}',
    invocation: 'frames(value=>value)',
    refused: false,
  },
  {
    id: 'generic-query-parameter-data-opacity',
    source:
      'function frames(make:<T extends Error>(value:T)=>typeof value){return make({name:"Error",message:"fixed",stack:"fixed"}).stack;}',
    invocation: 'frames(value=>value)',
    refused: false,
  },
  {
    id: 'generic-shadow-error-name-data-opacity',
    source:
      'type Data={stack:string};function frames(make:<Error>()=>Error){return make<Data>().stack;}',
    invocation: 'frames(<T,>()=>({stack:"fixed"})as never)',
    refused: false,
  },
  {
    id: 'construct-generic-independent-error',
    source: 'function frames(Make:new<T>()=>Error){return new Make<string>().stack;}',
    invocation: 'frames(globalThis.Error as unknown as new<T>()=>Error)',
    refused: true,
  },
  {
    id: 'construct-call-signature-not-selected-pin',
    source:
      'interface Maker{():Error;new():{stack:string}}function frames(Make:Maker){return new Make().stack;}',
    invocation: 'frames(class{stack="fixed"}as unknown as Maker)',
    refused: false,
  },
  {
    id: 'call-construct-signature-not-selected-pin',
    source:
      'interface Maker{():{stack:string};new():Error}function frames(make:Maker){return make().stack;}',
    invocation: 'frames((()=>({stack:"fixed"}))as unknown as Maker)',
    refused: false,
  },
  {
    id: 'outer-generic-call-result-data',
    source:
      'function frames<T extends Error>(make:<U>(value:U)=>{failure:T}){return make(0).failure.stack;}',
    invocation: 'frames(<U,>(_value:U)=>({failure:{name:"Fixed",message:"fixed",stack:"fixed"}}))',
    reader: false,
    refused: false,
  },
  {
    id: 'outer-generic-construct-result-data',
    source:
      'function frames<T extends Error>(Make:new<U>(value:U)=>{failure:T}){return new Make(0).failure.stack;}',
    invocation:
      'frames(class{failure={name:"Fixed",message:"fixed",stack:"fixed"};constructor(_value:unknown){}})',
    reader: false,
    refused: false,
  },
  {
    id: 'outer-generic-bare-call-data',
    source: 'function frames<T extends Error>(make:<U>(value:U)=>T){return make(0).stack;}',
    invocation: 'frames(<U,>(_value:U)=>({name:"Fixed",message:"fixed",stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'outer-generic-bare-construct-data',
    source: 'function frames<T extends Error>(Make:new<U>(value:U)=>T){return new Make(0).stack;}',
    invocation:
      'frames(class{name="Fixed";message="fixed";stack="fixed";constructor(_value:unknown){}})',
    refused: false,
  },
  {
    id: 'bound-outer-alias-generic-call-error',
    source:
      'type Maker<T>=<U>(value:U)=>{failure:T};function frames(make:Maker<Error>){return make(0).failure.stack;}',
    invocation: 'frames(<U,>(_value:U)=>({failure:new Error("ours")}))',
    refused: true,
  },
  {
    id: 'bound-outer-alias-generic-call-data-pin',
    source:
      'type Maker<T>=<U>(value:U)=>{failure:T};function frames(make:Maker<{stack:string}>){return make(0).failure.stack;}',
    invocation: 'frames(<U,>(_value:U)=>({failure:{stack:"fixed"}}))',
    refused: false,
  },
  {
    id: 'bound-outer-alias-generic-construct-error',
    source:
      'interface Maker<T>{new<U>(value:U):{failure:T}}function frames(Make:Maker<Error>){return new Make(0).failure.stack;}',
    invocation: 'frames(class{failure=new Error("ours");constructor(_value:unknown){}})',
    refused: true,
  },
  {
    id: 'bound-outer-alias-generic-construct-data-pin',
    source:
      'interface Maker<T>{new<U>(value:U):{failure:T}}function frames(Make:Maker<{stack:string}>){return new Make(0).failure.stack;}',
    invocation: 'frames(class{failure={stack:"fixed"};constructor(_value:unknown){}})',
    refused: false,
  },
  {
    id: 'existing-nongeneric-outer-constraint-pin',
    source: 'function frames<T extends Error>(make:()=>T){return make().stack;}',
    invocation: 'frames(()=>({name:"Fixed",message:"fixed",stack:"fixed"}))',
    refused: true,
  },
  {
    id: 'outer-generic-hidden-interface-call-data',
    source:
      'function frames<T extends Error>(value:T){interface Box{failure:T}function read(make:<U>(value:U)=>Box){return make(0).failure.stack;}return read(<U,>(_value:U)=>({failure:value}));}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'outer-generic-hidden-interface-construct-data',
    source:
      'function frames<T extends Error>(value:T){interface Box{failure:T}function read(Make:new<U>(value:U)=>Box){return new Make(0).failure.stack;}return read(class{failure=value;constructor(_value:unknown){}});}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nongeneric-construct-outer-result-data',
    source:
      'function frames<T extends Error>(Make:new()=>{failure:T}){return new Make().failure.stack;}',
    invocation: 'frames(class{failure={name:"Fixed",message:"fixed",stack:"fixed"}})',
    refused: false,
  },
];

describe('typed invocation result readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'typed-invocation-results.ts', source);
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

describe('shared typed invocation result admissions', () => {
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
