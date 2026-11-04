import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'borrowed-call-error',
    source:
      'function frames(error:Error){return Array.prototype.some.call([error],value=>value.stack!.includes("Firefox"));}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    group: 'borrowed',
  },
  {
    id: 'borrowed-apply-error',
    source:
      'function frames(error:Error){return Array.prototype.some.apply([error],[value=>value.stack!.includes("Firefox")]);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    group: 'borrowed',
  },
  {
    id: 'borrowed-reflect-error',
    source:
      'function frames(error:Error){return Reflect.apply(Array.prototype.some,[error],[(value:any)=>value.stack!.includes("Firefox")]);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    group: 'borrowed',
  },
  {
    id: 'borrowed-global-error',
    source:
      'function frames(error:Error){return globalThis.Array.prototype.some.call([error],value=>value.stack!.includes("Firefox"));}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    group: 'borrowed',
  },
  {
    id: 'borrowed-native-alias-error',
    source:
      'function frames(error:Error){const some=Array.prototype.some;return some.call([error],value=>value.stack!.includes("Firefox"));}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    group: 'borrowed',
  },
  {
    id: 'borrowed-spread-receiver-error',
    source:
      'function frames(error:Error){return Array.prototype.some.call(...[[error]]as[Error[]],value=>value.stack!.includes("Firefox"));}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    group: 'borrowed',
  },
  {
    id: 'borrowed-call-data',
    source:
      'function frames(){return Array.prototype.some.call([{stack:"fixed"}],value=>value.stack.includes("Firefox"));}',
    refused: false,
    invocation: 'frames()',
    group: 'borrowed',
  },
  {
    id: 'borrowed-apply-local-words',
    source:
      'function frames(){return Array.prototype.some.apply([new Error("fixed")],[value=>value.message.includes("fixed")]);}',
    refused: false,
    invocation: 'frames()',
    group: 'borrowed',
  },
  {
    id: 'borrowed-empty',
    source:
      'function frames(){return Array.prototype.some.call([]as Error[],value=>value.stack!.includes("Firefox"));}',
    refused: false,
    invocation: 'frames()',
    group: 'borrowed',
  },
  {
    id: 'borrowed-ignores-own-method',
    source:
      'function frames(error:Error){const items=[error];items.some=()=>false;return Array.prototype.some.call(items,value=>value.stack!.includes("Firefox"));}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    group: 'borrowed',
  },
  {
    id: 'borrowed-array-shadow',
    source:
      'function frames(error:Error){const Array={prototype:{some:{call:(_items:unknown,_callback:(value:any)=>boolean)=>false}}};return Array.prototype.some.call([error],value=>value.stack!.includes("Firefox"));}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    group: 'borrowed',
  },
  {
    id: 'borrowed-reflect-shadow',
    source:
      'function frames(error:Error){const Reflect={apply:(_method:unknown,_items:unknown,_args:unknown[])=>false};return Reflect.apply(Array.prototype.some,[error],[(value:any)=>value.stack!.includes("Firefox")]);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    group: 'borrowed',
  },
  {
    id: 'borrowed-index-data',
    source:
      'function frames(error:Error){return Array.prototype.some.call([error],(_value,index)=>index>0);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    group: 'borrowed',
  },
  {
    id: 'set-first-error',
    source:
      'function frames(error:Error){return new Set([error]).forEach(value=>value.stack!.includes("Firefox"));}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    group: 'collection',
  },
  {
    id: 'map-first-error',
    source:
      'function frames(error:Error){return new Map([["key",error]]).forEach(value=>value.stack!.includes("Firefox"));}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    group: 'collection',
  },
  {
    id: 'set-second-error',
    source:
      'function frames(error:Error){return new Set([error]).forEach((_value,key)=>key.stack!.includes("Firefox"));}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    group: 'collection',
  },
  {
    id: 'map-second-key-error',
    source:
      'function frames(error:Error){return new Map([[error,"fixed"]]).forEach((_value,key)=>key.stack!.includes("Firefox"));}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    group: 'collection',
  },
  {
    id: 'set-aliased-destructured-error',
    source:
      'function frames(error:Error){const items=new Set([{failure:error}]);const alias=items;return alias.forEach(({failure})=>failure.stack!.includes("Firefox"));}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    group: 'collection',
  },
  {
    id: 'map-first-ignores-error-key',
    source:
      'function frames(error:Error){return new Map([[error,{stack:"fixed"}]]).forEach(value=>value.stack.includes("Firefox"));}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    group: 'collection',
  },
  {
    id: 'set-local-written-words',
    source:
      'function frames(){return new Set([new Error("fixed")]).forEach(value=>value.message.includes("fixed"));}',
    refused: false,
    invocation: 'frames()',
    group: 'collection',
  },
  {
    id: 'set-empty',
    source:
      'function frames(){return new Set<Error>().forEach(value=>value.stack!.includes("Firefox"));}',
    refused: false,
    invocation: 'frames()',
    group: 'collection',
  },
  {
    id: 'map-empty',
    source:
      'function frames(){return new Map<string,Error>().forEach(value=>value.stack!.includes("Firefox"));}',
    refused: false,
    invocation: 'frames()',
    group: 'collection',
  },
  {
    id: 'set-own-for-each',
    source:
      'function frames(error:Error){const items=new Set([error]);items.forEach=()=>{};return items.forEach(value=>value.stack!.includes("Firefox"));}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    group: 'collection',
  },
  {
    id: 'map-own-for-each',
    source:
      'function frames(error:Error){const items=new Map([["key",error]]);items.forEach=()=>{};return items.forEach(value=>value.stack!.includes("Firefox"));}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    group: 'collection',
  },
  {
    id: 'local-set-shadow',
    source:
      'function frames(error:Error){const Set=class{constructor(_items:unknown){}forEach(_callback:(value:any)=>unknown){}};return new Set([error]).forEach(value=>value.stack!.includes("Firefox"));}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    group: 'collection',
  },
  {
    id: 'local-map-shadow',
    source:
      'function frames(error:Error){const Map=class{constructor(_items:unknown){}forEach(_callback:(value:any)=>unknown){}};return new Map([["key",error]]).forEach(value=>value.stack!.includes("Firefox"));}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    group: 'collection',
  },
  {
    id: 'typed-set-parameter',
    source:
      'function frames(items:Set<Error>){return items.forEach(value=>value.stack!.includes("Firefox"));}',
    refused: true,
    invocation: 'frames(new Set([new Error("ours")]))',
    group: 'collection',
  },
  {
    id: 'typed-map-parameter',
    source:
      'function frames(items:Map<string,Error>){return items.forEach(value=>value.stack!.includes("Firefox"));}',
    refused: true,
    invocation: 'frames(new Map([["key",new Error("ours")]]))',
    group: 'collection',
  },
  {
    id: 'map-overwritten-error-data',
    source:
      'function frames(error:Error){return new Map<string,Error|{stack:string}>([["key",error],["key",{stack:"fixed"}]]).forEach(value=>value.stack!.includes("Firefox"));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    group: 'collection',
  },
];

describe('borrowed array and collection callback readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'blob-parts.ts', source);
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

describe('shared borrowed array and collection callbacks', () => {
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
