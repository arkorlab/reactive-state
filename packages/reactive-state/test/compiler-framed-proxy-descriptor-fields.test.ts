import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A native descriptor trap converts its returned value getter to a data descriptor value.
 * Attribute and argument evaluation retain their native order and existing opacity boundaries.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly retainedShape?: boolean;
  readonly native: string | boolean;
  readonly nativeMode: string;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-value-getter',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'reflect-value-getter',
    source:
      'function frames(error:Error){return Reflect.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'computed-value-getter',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get ["value"](){return error;}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'value-getter-setter-pair',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;},set value(_next:unknown){}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'function-property-trap',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor:function(){return {configurable:true,get value(){return error;}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'arrow-property-trap',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor:()=>({configurable:true,get value(){return error;}})}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'getter-supplied-message',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!.value.message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'supplied',
    nativeMode: 'exact',
  },
  {
    id: 'nested-value-container',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return {failure:error};}};}}),"failure")!.value.failure.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'array-value-container',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return [error];}};}}),"failure")!.value[0].stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'proxy-alias',
    source:
      'function frames(error:Error){const proxy=new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}});return Object.getOwnPropertyDescriptor(proxy,"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'descriptor-alias',
    source:
      'function frames(error:Error){const descriptor=Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!;return descriptor.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'constant-returned-descriptor',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){const descriptor={configurable:true,get value(){return error;}};return descriptor;}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'plural-value-getter',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptors(new Proxy({},{ownKeys(){return ["failure"];},getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}})).failure.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'metadata-fields',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,enumerable:true,writable:false,get value(){return error;}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'local-made-stack',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return new Error("local");}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: local',
    nativeMode: 'contains',
  },
  {
    id: 'caught-stack',
    source:
      'function frames(error:Error){try{throw new Error("caught");}catch(caught){return Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,get value(){return caught;}};}}),"failure")!.value.stack;}}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: caught',
    nativeMode: 'contains',
  },
  {
    id: 'getter-literal-data',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return {stack:"fixed"};}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'get-field-is-metadata',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get(){return error;}};}}),"failure")!.value?.stack??"fixed";}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'get-field-accessor-is-metadata',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get get(){return ()=>error;}};}}),"failure")!.value?.stack??"fixed";}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'setter-only-value',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,set value(_next:unknown){}};}}),"failure")!.value?.stack??"fixed";}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'local-made-message',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return new Error("local");}};}}),"failure")!.value.message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'local',
    nativeMode: 'exact',
  },
  {
    id: 'metadata-only-observation',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!.configurable;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: true,
    nativeMode: 'exact',
  },
  {
    id: 'own-fixed-stack-before',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});return Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'later-writable-getter-fixes-stack',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;},get writable(){Object.assign(error,{stack:"fixed"});return true;}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'trap-prefix-fixes-stack',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){const ignored=Object.assign(error,{stack:"fixed"});return {configurable:true,get value(){return error;}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
    retainedShape: true,
  },
  {
    id: 'value-getter-throws',
    source:
      'function frames(error:Error){try{return Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,get value(){throw new Error("fixed");}};}}),"failure")!.value.stack;}catch{return "fixed";}}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'value-getter-accessor-conflict',
    source:
      'function frames(error:Error){try{return Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;},get(){return error;}};}}),"failure")!.value.stack;}catch{return "fixed";}}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'nonconfigurable-invariant',
    source:
      'function frames(error:Error){try{return Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:false,get value(){return error;}};}}),"failure")!.value.stack;}catch{return "fixed";}}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'missing-plural-key',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptors(new Proxy({},{ownKeys(){return ["failure"];},getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}})).missing?.value?.stack??"fixed";}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'empty-plural-keys',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptors(new Proxy({},{ownKeys(){return [];},getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}})).failure?.value?.stack??"fixed";}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'descriptor-value-written',
    source:
      'function frames(error:Error){const descriptor=Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!;descriptor.value={stack:"fixed"};return descriptor.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'ignored-call-tail-fixes',
    source:
      'function frames(error:Error){return (Object.getOwnPropertyDescriptor as(...args:unknown[])=>PropertyDescriptor)(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure",Object.assign(error,{stack:"fixed"}))!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'ignored-proxy-tail-fixes',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new (Proxy as unknown as new(...args:unknown[])=>object)({}, {getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}},Object.assign(error,{stack:"fixed"})),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
    retainedShape: true,
  },
  {
    id: 'unknown-prefix-bridge',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,get value(){return value;}};}}),"failure")!.value.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'trap-default-bridge',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>unknown){return Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(_target,_key,_ignored=prepare()){return {configurable:true,get value(){return value;}};}}),"failure")!.value.stack;}return collect(error,()=>Object.assign(error,{stack:"fixed"}));}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'local-Object',
    source:
      'const Object={getOwnPropertyDescriptor:(_target:unknown,_key:unknown)=>({value:{stack:"fixed"}})};function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'local-Proxy',
    source:
      'class Proxy{constructor(_target:unknown,_handler:unknown){return {failure:{stack:"fixed"}};}}function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'local-Error',
    source:
      'class Error{stack="fixed";constructor(_message?:unknown){}}function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'native-key-coercion-fixes',
    source:
      'function frames(error:Error){const key={toString(){Object.assign(error,{stack:"fixed"});return "failure";}};return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),key as never)!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'plural-numeric-key-throws',
    source:
      'function frames(error:Error){try{return Object.getOwnPropertyDescriptors(new Proxy({},{ownKeys(){return [1] as never;},getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}))["1"].value.stack;}catch{return "fixed";}}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'destructured-value-getter',
    source:
      'function frames(error:Error){const {value}=Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!;return value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'plural-destructured-value-getter',
    source:
      'function frames(error:Error){const {failure:{value}}=Object.getOwnPropertyDescriptors(new Proxy({},{ownKeys(){return ["failure"];},getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}));return value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'later-value-data-override',
    source:
      'function frames(error:Error){const first={configurable:true,get value(){return error;}};const descriptor={...first,value:{stack:"fixed"}};return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return descriptor;}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'earlier-configurable-getter-fixes',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {get configurable(){Object.assign(error,{stack:"fixed"});return true;},get value(){return error;}};}}),"failure")!.value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'binding-written-value',
    source:
      'function frames(error:Error){const {value}=Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!;Object.assign(value,{stack:"fixed"});return value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'binding-evaluated-tail-default',
    source:
      'function frames(error:Error){const {value,unused=Object.assign(error,{stack:"fixed"})}=Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")! as PropertyDescriptor&{unused?:unknown};return value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'binding-unknown-prefix-bridge',
    source:
      'function frames(error:Error){function collect(item:Error,prepare:()=>void){prepare();const {value}=Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return item;}};}}),"failure")!;return value.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'reflected-read-receiver-fixes',
    source:
      'function frames(error:Error){return Reflect.get(Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!,"value",Object.assign(error,{stack:"fixed"})).stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'reflected-read-quiet-receiver',
    source:
      'function frames(error:Error){return Reflect.get(Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")!,"value",{}).stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
    nativeMode: 'contains',
  },
  {
    id: 'computed-value-key-fixes',
    source:
      'function frames(error:Error){const key={toString(){Object.assign(error,{stack:"fixed"});return "value";}};return (Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,get value(){return error;}};}}),"failure")![key as never] as unknown as {stack:string}).stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'bound-data-trap-prefix-fixes',
    source:
      'function frames(error:Error){const {value}=Object.getOwnPropertyDescriptor(new Proxy({},{getOwnPropertyDescriptor(){const ignored=Object.assign(error,{stack:"fixed"});return {configurable:true,value:error};}}),"failure")!;return value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
    retainedShape: true,
  },
  {
    id: 'bound-data-native-tail-fixes',
    source:
      'function frames(error:Error){const {value}=(Object.getOwnPropertyDescriptor as(...args:unknown[])=>PropertyDescriptor)(new Proxy({},{getOwnPropertyDescriptor(){return {configurable:true,value:error};}}),"failure",Object.assign(error,{stack:"fixed"}));return value.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
];

describe('proxy descriptor field readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'proxy-descriptor-fields.ts', source);
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

describe('shared proxy descriptor field admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, retainedShape }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining(
      retainedShape === true ? 'whose flags differ' : 'a shared module that answers otherwise',
    );
    const expected = refused || retainedShape === true ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
