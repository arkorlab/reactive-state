import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** The seven reported type and callable result patterns. */
const CASES = [
  {
    id: 'optional-tuple-error',
    source:
      'type R<T>=T extends[value?:infer U]?U:{stack:string};type Failure=R<[Error]>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'optional-tuple-data',
    source:
      'type R<T>=T extends[value?:infer U]?U:{stack:string};type Failure=R<[{stack:string}]>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'whole-method-value-error',
    source:
      'type R<T>=T extends{make:infer F}?F extends()=>unknown?ReturnType<F>:never:never;type Failure=R<{make():Error}>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-method-value-data',
    source:
      'type R<T>=T extends{make:infer F}?F extends()=>unknown?ReturnType<F>:never:never;type Failure=R<{make():{stack:string}}>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'checked-intersection-error',
    source:
      'type R<T>=T extends{value:infer U}?U:{stack:string};type Failure=R<{value:Error}&{other:string}>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'checked-intersection-data',
    source:
      'type R<T>=T extends{value:infer U}?U:{stack:string};type Failure=R<{value:{stack:string}}&{other:string}>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'constrained-empty-inference-error',
    source:
      'type R<T>=T extends{x?:infer U extends Error}?U:{stack:string};type Failure=R<{}>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'constrained-empty-inference-data',
    source:
      'type R<T>=T extends{x?:infer U extends{stack:string}}?U:{stack:string};type Failure=R<{}>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'returntype-typeof-error',
    source:
      'function make():Error{return new Error("ours")}type Failure=ReturnType<typeof make>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-typeof-data',
    source:
      'function make():{stack:string}{return{stack:"fixed"}}type Failure=ReturnType<typeof make>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'factory-borrowed-call-error',
    source:
      'function make(){return new Error("ours")}function read(){return make.call(null).stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    id: 'factory-borrowed-call-data',
    source: 'function make(){return{stack:"fixed"}}function read(){return make.call(null).stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'constrained-distribution-error',
    source:
      'type R<T extends Error|string>=T extends Error?Error:{stack:string};type Failure=R<Error|string>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'constrained-distribution-data',
    source:
      'type R<T extends Error|string>=T extends Error?Error:{stack:string};type Failure=R<string>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'optional-absent-constrained-error',
    source:
      'type R<T>=T extends[value?:infer U extends Error]?U:{stack:string};type Failure=R<[]>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'optional-too-many-data',
    source:
      'type R<T>=T extends[value?:infer U]?U:{stack:string};type Failure=R<[Error,Error]>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'optional-readonly-target-error',
    source:
      'type R<T>=T extends readonly[value?:infer U]?U:{stack:string};type Failure=R<readonly[Error]>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'optional-readonly-source-mutable-target-data',
    source:
      'type R<T>=T extends[value?:infer U]?U:{stack:string};type Failure=R<readonly[Error]>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'method-call-required-parameter-data',
    source:
      'type R<T>=T extends{make:infer F}?F extends()=>unknown?ReturnType<F>:{stack:string}:{stack:string};type Failure=R<{make(value:string):Error}>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'optional-method-required-property-data',
    source:
      'type R<T>=T extends{make:infer F}?F extends()=>unknown?ReturnType<F>:{stack:string}:{stack:string};type Failure=R<{make?():Error}>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'intersection-generic-environment-error',
    source:
      'type Box<T>={value:T};type R<T>=T extends{value:infer U}?U:{stack:string};type Failure=R<Box<Error>&{other:string}>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'intersection-unselected-error-data',
    source:
      'type Box<T>={value:T};type R<T>=T extends{value:infer U}?U:{stack:string};type Failure=R<Box<{stack:string}>&{other:Error}>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'intersection-combined-required-fields-error',
    source:
      'type R<T>=T extends{value:infer U;other:string}?U:{stack:string};type Failure=R<{value:Error}&{other:string}>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'intersection-other-literal-mismatch-data',
    source:
      'type R<T>=T extends{value:infer U;kind:"selected"}?U:{stack:string};type Failure=R<{value:Error}&{kind:"other"}>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'returntype-constant-arrow-error',
    source:
      'const make=():Error=>new Error("ours");type Failure=ReturnType<typeof make>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-value-shadow-data',
    source:
      'function make():Error{return new Error("ours")}function read(){const make=():{stack:string}=>({stack:"fixed"});const error:ReturnType<typeof make>={stack:"fixed"};return error.stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'returntype-utility-shadow-data',
    source:
      'type ReturnType<T>={stack:string};function make():Error{return new Error("ours")}type Failure=ReturnType<typeof make>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'parameters-typeof-error',
    source:
      'function make(error:Error):void{}type Failure=Parameters<typeof make>[0];function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-last-overload-error',
    source:
      'function make(value:string):{stack:string};function make(value:number):Error;function make(value:string|number):Error|{stack:string}{return new Error("ours")}type Failure=ReturnType<typeof make>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-last-overload-data',
    source:
      'function make(value:string):Error;function make(value:number):{stack:string};function make(value:string|number):Error|{stack:string}{return new Error("ours")}type Failure=ReturnType<typeof make>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'factory-borrowed-apply-error',
    source:
      'function make(){return new Error("ours")}function read(){return make.apply(null,[]).stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    id: 'factory-borrowed-reflect-error',
    source:
      'function make(){return new Error("ours")}function read(){return Reflect.apply(make,null,[]).stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    id: 'factory-borrowed-call-actual-error',
    source:
      'function make(value:any){return value}function read(error:Error){return make.call(null,error).stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'factory-borrowed-call-third-actual-error',
    source:
      'function make(a:any,b:any,value:any){return value}function read(error:Error){return make.call(null,0,0,error).stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'factory-borrowed-alias-error',
    source:
      'function make(){return new Error("ours")}const alias=make;function read(){return alias.call(null).stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    id: 'factory-borrowed-apply-default-error',
    source:
      'function make(value:Error=new Error("ours")){return value}function read(){return make.apply(null,null).stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    id: 'factory-custom-call-data',
    source:
      'const make={call(_self:unknown){return{stack:"fixed"}}};function read(){return make.call(null).stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'factory-reflect-shadow-data',
    source:
      'function make(){return new Error("ours")}const Reflect={apply(_fn:unknown,_self:unknown,_args:unknown[]){return{stack:"fixed"}}};function read(){return Reflect.apply(make,null,[]).stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'factory-borrowed-apply-own-words',
    source:
      'function make(){return new Error("ours")}function read(){return make.apply(null,[]).message;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'factory-own-call-method-data',
    source:
      'function read(){function make(){return new Error("ours")}Object.defineProperty(make,"call",{value:()=>({stack:"fixed"})});return make.call(null).stack;}',
    invocation: 'read()',
    refused: false,
  },
];

describe('late type and factory readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'instance-factory.ts', source);
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

describe('shared late type and factory results', () => {
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

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
