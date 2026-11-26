import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'reported-same-statement-reflect-delete',
    source:
      'function frames(error:Error){const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'same-statement-direct-delete',
    source:
      'function frames(error:Error){const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});return(delete(iter as {next?:unknown}).next,iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'separate-statement-restoration-pin',
    source:
      'function frames(error:Error){const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});Reflect.deleteProperty(iter,"next");return iter.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'intact-own-method-data',
    source:
      'function frames(error:Error){const iter=new Set<{stack?:string}>([error]).values();iter.next=()=>({done:false as const,value:{stack:"fixed"}});return iter.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'delete-in-next-ignored-argument-data',
    source:
      'function frames(error:Error){const iter=new Set<{stack?:string}>([error]).values();iter.next=()=>({done:false as const,value:{stack:"fixed"}});return(iter.next as(...args:unknown[])=>IteratorResult<{stack?:string}>)(Reflect.deleteProperty(iter,"next")).value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'pre-delete-error-rewrite-data',
    source:
      'function frames(error:Error){const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});return(Object.assign(error,{stack:"fixed"}),Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'nonconfigurable-own-delete-fails-data',
    source:
      'function frames(error:Error){const iter=new Set<{stack?:string}>([error]).values();Object.defineProperty(iter,"next",{value:()=>({done:false as const,value:{stack:"fixed"}}),writable:true,configurable:false});iter.next=()=>({done:false as const,value:{stack:"fixed"}});return(Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'whole-iterator-alias-restoration',
    source:
      'function frames(error:Error){const iter=new Set([error]).values();const same=iter;same.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),same.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-map-value-restoration',
    source:
      'function frames(error:Error){const iter=new Map([["failure",error]]).values();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-map-key-restoration',
    source:
      'function frames(error:Error){const iter=new Map([[error,0]]).keys();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-map-entry-value-restoration',
    source:
      'function frames(error:Error){const iter=new Map([["failure",error]]).entries();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value![1].stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-map-entry-data-key',
    source:
      'function frames(error:Error){const iter=new Map([[{stack:"fixed"},error]]).entries();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value![0].stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'native-set-entry-restoration-0',
    source:
      'function frames(error:Error){const iter=new Set([error]).entries();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value![0].stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-set-entry-restoration-1',
    source:
      'function frames(error:Error){const iter=new Set([error]).entries();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value![1].stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-delete-function-alias',
    source:
      'function frames(error:Error){const remove=Reflect.deleteProperty;const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});return(remove(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'next-key-constant-alias',
    source:
      'function frames(error:Error){const key="next";const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,key),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-function-constant-alias',
    source:
      'function frames(error:Error){const own=()=>({done:true as const,value:undefined});const iter=new Set([error]).values();iter.next=own;return(Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-collection-constructor-alias',
    source:
      'function frames(error:Error){const Native=Set;const iter=new Native([error]).values();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-collection-instance-alias',
    source:
      'function frames(error:Error){const values=new Set([error]);const iter=values.values();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'pre-birth-error-rewrite-data',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'saved-value-later-rewrite-data',
    source:
      'function frames(error:Error){const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});const value=(Reflect.deleteProperty(iter,"next"),iter.next().value!);Object.assign(error,{stack:"fixed"});return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'computed-observation-rewrite-data',
    source:
      'function frames(error:Error){const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value![(Object.assign(error,{stack:"fixed"}),"stack")]);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'conditionally-skipped-deletion-data',
    source:
      'function frames(error:Error){const iter=new Set<{stack?:string}>([error]).values();iter.next=()=>({done:false as const,value:{stack:"fixed"}});return(false&&Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'native-delete-ignored-tail-rewrite-data',
    source:
      'function frames(error:Error){const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});return((Reflect.deleteProperty as(...args:unknown[])=>boolean)(iter,"next",Object.assign(error,{stack:"fixed"})),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'native-delete-ignored-quiet-tail',
    source:
      'function frames(error:Error){const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});return((Reflect.deleteProperty as(...args:unknown[])=>boolean)(iter,"next",0),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'unrelated-slot-deletion-data',
    source:
      'function frames(error:Error){const iter=new Set<{stack?:string}>([error]).values();iter.next=()=>({done:false as const,value:{stack:"fixed"}});return(Reflect.deleteProperty(iter,"other"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'local-delete-shadow-data',
    source:
      'function frames(error:Error){const Reflect={deleteProperty(_target:unknown,_key:unknown){return true;}};const iter=new Set<{stack?:string}>([error]).values();iter.next=()=>({done:false as const,value:{stack:"fixed"}});return(Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'constructor-ignored-tail-rewrite-data',
    source:
      'function frames(error:Error){const iter=new(Set as new(...args:unknown[])=>Set<Error>)([error],Object.assign(error,{stack:"fixed"})).values();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'captured-origin-earlier-owner-data',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});function read(){const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}return read();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'parameter-default-earlier-work-data',
    source:
      'function frames(error:Error,_prepared=(Object.assign(error,{stack:"fixed"}),0)){const iter=new Set([error]).values();iter.next=()=>({done:true as const,value:undefined});return(Reflect.deleteProperty(iter,"next"),iter.next().value!.stack);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native iterator method restoration words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'iterator-restorations.ts', source);
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

describe('shared native iterator method restoration admission', () => {
  let api: API;
  const apps: Application[] = [];
  const observations: unknown[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    const file = process.env['RECOVERY_FORWARDING_OBSERVATIONS'];
    if (file !== undefined) writeFileSync(file, JSON.stringify(observations, null, 2));
    api[Symbol.dispose]();
    await Promise.all(apps.map(async (app) => removed(app)));
  });

  it.each(CASES)('$id', async ({ id, source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compiledApp(app, api).refusals.map((item) => item.reason);
    observations.push({ id, source, expectedRefused: refused, reasons });
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
