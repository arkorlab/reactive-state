import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * Accessors code defines with `Object.defineProperty`, `Object.defineProperties` or
 * `Reflect.defineProperty`: a getter's returns are the member's possible values, and a later
 * assignment its setter takes leaves them possible. (WIP: the reader does not follow these yet.)
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'defined-accessor-then-assign',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});o.x={stack:'fixed'};return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'defined-properties-accessor',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperties(o,{x:{get(){return error;},set(_v:unknown){},configurable:true}});o.x={stack:'fixed'};return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'defined-getter-read',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;}});return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reflect-defined-getter-read',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Reflect.defineProperty(o,'x',{get:()=>error});return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'defined-getter-prototype',
    source:
      "function frames(error:Error){const P:{x?:{stack?:string}}={};Object.defineProperty(P,'x',{get(){return error;}});const o={__proto__:P} as unknown as {x?:{stack?:string}};return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'defined-writable-value-then-assign',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{value:error,writable:true,configurable:true});o.x={stack:'fixed'};return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'defined-setter-only',
    source:
      "function frames(error:Error){const o:{x?:unknown}={};Object.defineProperty(o,'x',{set(_v:unknown){}});o.x=error;return String(o.x);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'defined-data-getter-takes-error-assignment',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return{stack:'fixed'};},set(_v:unknown){},configurable:true});o.x=error;return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'data-definition-replaces-getter',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});Object.defineProperty(o,'x',{value:{stack:'fixed'},writable:true,configurable:true});return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'data-definition-restores-ordinary-assignment',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});Object.defineProperty(o,'x',{value:{stack:'fixed'},writable:true,configurable:true});o.x=error;return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'partial-setter-definition-keeps-getter',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});Object.defineProperty(o,'x',{set(_v:unknown){}});o.x={stack:'fixed'};return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'explicit-undefined-get-clears-getter',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});Object.defineProperty(o,'x',{get:undefined,set(_v:unknown){}});o.x=error;return String(o.x);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'prior-error-rewrite-data',
    source:
      "function frames(error:Error){Object.assign(error,{stack:'fixed'});const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'getter-body-effects-data',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){Object.assign(error,{stack:'fixed'});return error;},set(_v:unknown){},configurable:true});return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'setter-body-effects-data',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){Object.assign(error,{stack:'fixed'});},configurable:true});o.x={stack:'fixed'};return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unknown-prefix-bridge-data',
    source:
      "function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return value;},set(_v:unknown){},configurable:true});return o.x?.stack;}return collect(error,()=>{Object.assign(error,{stack:'fixed'});});}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'whole-target-alias-getter',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};const alias=o;Object.defineProperty(alias,'x',{get(){return error;}});return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'object-assign-through-empty-setter',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});Object.assign(o,{x:{stack:'fixed'}});return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'later-getter-does-not-change-saved-data',
    source:
      "function frames(error:Error){const o:{x:{stack?:string}}={x:error};o.x={stack:'fixed'};const result=o.x.stack;Object.defineProperty(o,'x',{get(){return error;}});return result;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'definition-ignored-tail-rewrite-data',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};(Object.defineProperty as(...args:any[])=>unknown)(o,'x',{get(){return error;}},Object.assign(error,{stack:'fixed'}));return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'locally-made-getter-frames',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return new Error('ours');}});return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'locally-made-getter-words',
    source:
      "function frames(error:Error){const o:{x?:{message?:string}}={};Object.defineProperty(o,'x',{get(){return new Error('fixed');}});return o.x?.message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'empty-setter-cannot-replace-earlier-getter',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});Object.defineProperty(o,'x',{set:()=>{}});o.x={stack:'fixed'};return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'attribute-only-definition-keeps-getter',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});Object.defineProperty(o,'x',{enumerable:true});o.x={stack:'fixed'};return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'data-to-accessor-clears-old-value',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{value:{stack:'fixed'},writable:true,configurable:true});Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'later-getter-replaces-error-getter',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});Object.defineProperty(o,'x',{get(){return{stack:'fixed'};}});return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'inherited-empty-setter-keeps-getter',
    source:
      "function frames(error:Error){const P:{x?:{stack?:string}}={};Object.defineProperty(P,'x',{get(){return error;},set(_v:unknown){},configurable:true});const o={__proto__:P} as unknown as {x?:{stack?:string}};o.x={stack:'fixed'};return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-data-shadows-defined-prototype-getter',
    source:
      "function frames(error:Error){const P:{x?:{stack?:string}}={};Object.defineProperty(P,'x',{get(){return error;},set(_v:unknown){},configurable:true});const o={__proto__:P,x:{stack:'fixed'}};return o.x.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'after-definition-own-stack-data',
    source:
      "function frames(error:Error){const o:{x?:Error}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});error.stack='fixed';return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'after-definition-own-message-data',
    source:
      "function frames(error:Error){const o:{x?:Error}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});error.message='fixed';return o.x?.message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'after-definition-own-name-data',
    source:
      "function frames(error:Error){const o:{x?:Error}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});error.name='fixed';return o.x?.name;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'after-definition-return-binding-replaced',
    source:
      "function frames(error:Error){let held:Error|{stack:string}=error;const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return held;},set(_v:unknown){},configurable:true});held={stack:'fixed'};return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'descriptor-value-getter-effects-stay-opaque',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get value(){Object.assign(error,{stack:'fixed'});return error;},writable:true,configurable:true});return o.x?.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'returned-error-own-toString-stays-data',
    source:
      "function frames(error:Error){const o:{x?:{stack?:string}}={};Object.defineProperty(o,'x',{get(){return error;},set(_v:unknown){},configurable:true});Object.defineProperty(error,'toString',{value(){return'fixed';}});return String(o.x);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'computed-proto-field-is-own-data',
    source:
      "function frames(error:Error){const P:{x?:{stack?:string}}={};Object.defineProperty(P,'x',{get(){return error;},set(_v:unknown){},configurable:true});const o={['__proto__']:P} as unknown as {x?:{stack?:string}};return String(o.x?.stack);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'shorthand-proto-field-is-own-data',
    source:
      "function frames(error:Error){const P:{x?:{stack?:string}}={};Object.defineProperty(P,'x',{get(){return error;},set(_v:unknown){},configurable:true});const __proto__=P;const o={__proto__} as unknown as {x?:{stack?:string}};return String(o.x?.stack);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('defined accessor readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'defined-accessors.ts', source);
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

describe('shared defined accessor admissions', () => {
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
