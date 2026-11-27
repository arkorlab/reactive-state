import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Immediate native prototype selections retain the actual Object.create prototype and its boundaries. */
const CASES = [
  {
    id: 'object-direct',
    source:
      'function frames(error:Error){return Object.getPrototypeOf(Object.create(error)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
    runtime: 'frames',
  },
  {
    id: 'reflect-direct',
    source:
      'function frames(error:Error){return (Reflect.getPrototypeOf(Object.create(error)) as {stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
    runtime: 'frames',
  },
  {
    id: 'global-qualified',
    source:
      'function frames(error:Error){return globalThis.Object.getPrototypeOf(globalThis.Object.create(error)).message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
    runtime: 'ours',
  },
  {
    id: 'native-api-alias',
    source:
      'function frames(error:Error){const get=Object.getPrototypeOf;const create=Object.create;return get(create(error)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
    runtime: 'frames',
  },
  {
    id: 'source-alias',
    source:
      'function frames(error:Error){const source=Object.create(error);return (Reflect.getPrototypeOf(source) as {stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
    runtime: 'frames',
  },
  {
    id: 'local-created-stack',
    source:
      'function frames(error:Error){return Object.getPrototypeOf(Object.create(new Error("fixed"))).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
    runtime: 'local-frames',
  },
  {
    id: 'fixed-data',
    source:
      'function frames(error:Error){return Object.getPrototypeOf(Object.create({stack:"fixed"})).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
    runtime: 'fixed',
  },
  {
    id: 'local-shadow',
    source:
      'function frames(error:Error){const Object={getPrototypeOf:(_value:unknown)=>({stack:"fixed"}),create:(value:unknown)=>value};return Object.getPrototypeOf(Object.create(error)).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
    runtime: 'fixed',
  },
  {
    id: 'changed-prototype',
    source:
      'function frames(error:Error){const source=Object.create(error);Object.setPrototypeOf(source,{stack:"fixed"});return Object.getPrototypeOf(source).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
    runtime: 'fixed',
  },
  {
    id: 'error-field-replaced',
    source:
      'function frames(error:Error){error.stack="fixed";return Object.getPrototypeOf(Object.create(error)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
    qualification: 'Existing refusal control; originally misclassified as an accepted pin.',
    runtime: 'fixed',
  },
  {
    id: 'effectful-options',
    source:
      'function frames(error:Error){return Object.getPrototypeOf(Object.create(error,{get own(){error.stack="fixed";return{value:0};}})).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
    qualification: 'Existing refusal control; originally misclassified as an accepted pin.',
    runtime: 'fixed',
  },
  {
    id: 'effectful-extra',
    source:
      'function frames(error:Error){return (Object.getPrototypeOf as(...args:unknown[])=>any)(Object.create(error),error.stack="fixed").stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
    qualification: 'Existing refusal control; originally misclassified as an accepted pin.',
    runtime: 'fixed',
  },
  {
    id: 'own-native-api',
    source:
      'function frames(error:Error){Object.getPrototypeOf=()=>({stack:"fixed"});return Object.getPrototypeOf(Object.create(error)).stack;}',
    reader: false,
    refused: true,
    invocation: 'frames(new Error("ours"))',
    qualification: 'Existing refusal control; originally misclassified as an accepted pin.',
    runtime: 'fixed',
  },
  {
    id: 'prototype-own-descriptor-does-not-mask-prototype',
    source:
      'function frames(error:Error){return Object.getPrototypeOf(Object.create(error,{stack:{value:"own"}})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    runtime: 'frames',
  },
  {
    id: 'prototype-quiet-descriptor-getter',
    source:
      'function frames(error:Error){return (Reflect.getPrototypeOf(Object.create(error,{get own(){return{value:0};}})) as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    runtime: 'frames',
  },
  {
    id: 'prototype-whole-parameter-alias',
    source:
      'function frames(error:Error){const alias=error;return Object.getPrototypeOf(Object.create(alias)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    runtime: 'frames',
  },
  {
    id: 'prototype-whole-source-aliases',
    source:
      'function frames(error:Error){const source=Object.create(error);const alias=source;return (Reflect.getPrototypeOf(alias) as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    runtime: 'frames',
  },
  {
    id: 'prototype-global-reflect-message',
    source:
      'function frames(error:Error){return (globalThis.Reflect.getPrototypeOf(Object.create(error)) as {message:string}).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    runtime: 'ours',
  },
  {
    id: 'prototype-local-created-message-data',
    source:
      'function frames(){return Object.getPrototypeOf(Object.create(new Error("fixed"))).message;}',
    invocation: 'frames()',
    reader: false,
    refused: false,
    runtime: 'fixed',
  },
  {
    id: 'prototype-asserted-literal-data',
    source:
      'function frames(){return Object.getPrototypeOf(Object.create({stack:"fixed"} as Error)).stack;}',
    invocation: 'frames()',
    reader: false,
    refused: false,
    runtime: 'fixed',
  },
  {
    id: 'prototype-quiet-get-extra',
    source:
      'function frames(error:Error){return(Object.getPrototypeOf as(...args:unknown[])=>any)(Object.create(error),0).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    runtime: 'frames',
  },
  {
    id: 'prototype-quiet-create-extra',
    source:
      'function frames(error:Error){return Object.getPrototypeOf((Object.create as(...args:unknown[])=>any)(error,{},0)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    runtime: 'frames',
  },
  {
    id: 'prototype-prior-own-field-data',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return Object.getPrototypeOf(Object.create(error)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    runtime: 'fixed',
  },
  {
    id: 'prototype-prior-alias-field-data',
    source:
      'function frames(error:Error){const alias=error;Object.defineProperty(alias,"stack",{value:"fixed"});return Object.getPrototypeOf(Object.create(error)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    runtime: 'fixed',
  },
  {
    id: 'prototype-ignored-get-tail-field-data',
    source:
      'function frames(error:Error){return(Object.getPrototypeOf as(...args:unknown[])=>any)(Object.create(error),Object.defineProperty(error,"stack",{value:"fixed"})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    runtime: 'fixed',
  },
  {
    id: 'prototype-ignored-create-tail-field-data',
    source:
      'function frames(error:Error){return Object.getPrototypeOf((Object.create as(...args:unknown[])=>any)(error,{},Object.defineProperty(error,"stack",{value:"fixed"}))).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    runtime: 'fixed',
  },
  {
    id: 'prototype-effectful-map-getter-data',
    source:
      'function frames(error:Error){return Object.getPrototypeOf(Object.create(error,{get own(){Object.defineProperty(error,"stack",{value:"fixed"});return{value:0};}})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    runtime: 'fixed',
  },
  {
    id: 'prototype-effectful-descriptor-getter-data',
    source:
      'function frames(error:Error){return (Reflect.getPrototypeOf(Object.create(error,{own:{get value(){Object.defineProperty(error,"stack",{value:"fixed"});return 0;}}})) as {stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    runtime: 'fixed',
  },
  {
    id: 'prototype-unknown-descriptor-map-data',
    source:
      'function frames(error:Error,map:PropertyDescriptorMap){return Object.getPrototypeOf(Object.create(error,map)).stack;}',
    invocation:
      '(()=>{const error=new Error("ours");return frames(error,{get own(){Object.defineProperty(error,"stack",{value:"fixed"});return{value:0};}});})()',
    reader: false,
    refused: false,
    runtime: 'fixed',
  },
  {
    id: 'prototype-result-saved-later-input-write-data',
    source:
      'function frames(error:Error){const value=Object.getPrototypeOf(Object.create(error));Object.defineProperty(error,"stack",{value:"fixed"});return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    runtime: 'fixed',
  },
  {
    id: 'prototype-result-saved-later-result-write-data',
    source:
      'function frames(error:Error){const value=Reflect.getPrototypeOf(Object.create(error)) as {stack?:string};Object.defineProperty(value,"stack",{value:"fixed"});return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    runtime: 'fixed',
  },
  {
    id: 'prototype-result-saved-existing-opacity',
    source:
      'function frames(error:Error){const value=Object.getPrototypeOf(Object.create(error));return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    runtime: 'frames',
    qualification:
      'Stored getPrototypeOf result remains the existing opaque boundary; native runtime can expose frames.',
  },
  {
    id: 'prototype-native-borrowing-existing-opacity',
    source:
      'function frames(error:Error){return Object.getPrototypeOf.call(null,Object.create(error)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    runtime: 'frames',
    qualification:
      'Borrowed wrappers remain outside this direct native-call proof; native runtime can expose frames.',
  },
  {
    id: 'prototype-direct-error-is-not-error-prototype',
    source: 'function frames(error:Error){return Object.getPrototypeOf(error).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    runtime: 'empty',
  },
  {
    id: 'prototype-computed-literal-sensitive',
    source:
      'function frames(error:Error){return Object.getPrototypeOf(Object.create(error))["stack"];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    runtime: 'frames',
  },
  {
    id: 'prototype-computed-effect-data',
    source:
      'function frames(error:Error){return Object.getPrototypeOf(Object.create(error))[(Object.defineProperty(error,"stack",{value:"fixed"}),"stack")];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    runtime: 'fixed',
  },
  {
    id: 'prototype-loop-condition-use',
    source:
      'function frames(error:Error){let result:unknown;let i=0;do{result=Object.getPrototypeOf(Object.create(error)).stack;}while((void error,i++<1));return result;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
    runtime: 'frames',
  },
  {
    id: 'prototype-loop-condition-data',
    source:
      'function frames(error:Error){const Object={getPrototypeOf:(_value:unknown)=>({stack:"fixed"}),create:(value:unknown)=>value};let result:unknown;let i=0;do{result=Object.getPrototypeOf(Object.create(error)).stack;}while((void error,i++<1));return result;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
    runtime: 'fixed',
  },
];

describe('immediate getPrototypeOf readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-prototype-observation.ts', source);
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

describe('shared immediate getPrototypeOf admissions', () => {
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
