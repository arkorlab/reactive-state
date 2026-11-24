import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'array-values-review-case',
    source: 'function frames(error:Error){return[error].values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-values-supplied-message',
    source: 'function frames(error:Error){return[error].values().next().value!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-entries-selected-value',
    source: 'function frames(error:Error){return[error].entries().next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-default-iterator',
    source: 'function frames(error:Error){return[error][Symbol.iterator]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-default-symbol-alias',
    source:
      'function frames(error:Error){const iterate:typeof Symbol.iterator=Symbol.iterator;return[error][iterate]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-whole-source-alias',
    source:
      'function frames(error:Error){const source=[error];const alias=source;return alias.values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-whole-iterator-alias',
    source:
      'function frames(error:Error){const values=[error].values();const cursor=values;return cursor.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-both-whole-aliases',
    source:
      'function frames(error:Error){const source=[error];const alias=source;const values=alias.values();const cursor=values;return cursor.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-nested-selected-field',
    source:
      'function frames(error:Error){return[{failure:error}].values().next().value!.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-data-value-pin',
    source: 'function frames(error:Error){return[{stack:"fixed"}].values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-later-unselected-error-pin',
    source:
      'function frames(error:Error){return[{stack:"fixed"},error].values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-local-words-pin',
    source:
      'function frames(error:Error){return[new Error("fixed")].values().next().value!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-entries-key-pin',
    source:
      'function frames(error:Error){return([error].entries().next().value![0] as any).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-keys-data-pin',
    source: 'function frames(error:Error){return([error].keys().next().value! as any).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-hole-first-pin',
    source: 'function frames(error:Error){return[,error].values().next().value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-empty-pin',
    source: 'function frames(error:Error){return([]as Error[]).values().next().value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-own-values-pin',
    source:
      'function frames(error:Error){const source=[error];source.values=()=>[{stack:"fixed"}].values()as never;return source.values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-own-values-earlier-pin',
    source:
      'function frames(error:Error){const source=[error];source.values=()=>[{stack:"fixed"}].values()as never;const harmless=0;void harmless;return source.values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-own-entries-pin',
    source:
      'function frames(error:Error){const source=[error];source.entries=()=>[[0,{stack:"fixed"}]as const].values()as never;return source.entries().next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-own-symbol-pin',
    source:
      'function frames(error:Error){const source=[error];source[Symbol.iterator]=()=>[{stack:"fixed"}].values()as never;return source[Symbol.iterator]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-own-next-pin',
    source:
      'function frames(error:Error){const cursor=[error].values();cursor.next=()=>({done:false,value:{stack:"fixed"}})as never;return cursor.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-own-next-earlier-pin',
    source:
      'function frames(error:Error){const cursor=[error].values();cursor.next=()=>({done:false,value:{stack:"fixed"}})as never;const harmless=0;void harmless;return cursor.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-prior-progress-pin',
    source:
      'function frames(error:Error){const cursor=[error,{stack:"fixed"}].values();cursor.next();return cursor.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-prior-slot-replacement-pin',
    source:
      'function frames(error:Error){const source:[{stack?:string}]=[error];source[0]={stack:"fixed"};return source.values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-next-argument-rewrites-pin',
    source:
      'function frames(error:Error){return[error].values().next(Object.assign(error,{stack:"fixed"})as never).value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-values-argument-rewrites-pin',
    source:
      'function frames(error:Error){return([error].values as(...args:unknown[])=>ArrayIterator<Error>)(Object.assign(error,{stack:"fixed"})).next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-later-initializer-rewrites-pin',
    source:
      'function frames(error:Error){return[error,Object.assign(error,{stack:"fixed"})].values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-prior-written-stack-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return[error].values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-post-source-written-stack-pin',
    source:
      'function frames(error:Error){const source=[error];Object.defineProperty(error,"stack",{value:"fixed"});return source.values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-quiet-next-argument-sensitivity',
    source: 'function frames(error:Error){return[error].values().next(0 as never).value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-default-review-case',
    source:
      'function frames(error:Error){return new Set([error])[Symbol.iterator]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-default-message',
    source:
      'function frames(error:Error){return new Set([error])[Symbol.iterator]().next().value!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-default-value-slot',
    source:
      'function frames(error:Error){return new Map([["failure",error]])[Symbol.iterator]().next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-default-key-slot',
    source:
      'function frames(error:Error){return new Map([[error,"fixed"]])[Symbol.iterator]().next().value![0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-default-symbol-alias',
    source:
      'function frames(error:Error){const iterate:typeof Symbol.iterator=Symbol.iterator;return new Set([error])[iterate]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-default-whole-alias',
    source:
      'function frames(error:Error){const source=new Set([error]);const values=source[Symbol.iterator]();const cursor=values;return cursor.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-default-key-data-pin',
    source:
      'function frames(error:Error){return(new Map([["fixed",error]])[Symbol.iterator]().next().value![0]as any).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-entry-array-pin',
    source:
      'function frames(error:Error){return(new Map([["fixed",error]])[Symbol.iterator]().next().value!as any).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-first-data-pin',
    source:
      'function frames(error:Error){return new Map<string,{stack?:string}>([["a",{stack:"fixed"}],["b",error]])[Symbol.iterator]().next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-first-data-pin',
    source:
      'function frames(error:Error){return new Set([{stack:"fixed"},error])[Symbol.iterator]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-local-words-pin',
    source:
      'function frames(error:Error){return new Set([new Error("fixed")])[Symbol.iterator]().next().value!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-own-values-bypassed',
    source:
      'function frames(error:Error){const source=new Set([error]);source.values=()=>[{stack:"fixed"}].values()as never;return source[Symbol.iterator]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-default-own-symbol-pin',
    source:
      'function frames(error:Error){const source=new Set([error]);source[Symbol.iterator]=()=>[{stack:"fixed"}].values()as never;return source[Symbol.iterator]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-own-symbol-pin',
    source:
      'function frames(error:Error){const source=new Map([["failure",error]]);source[Symbol.iterator]=()=>[["fixed",{stack:"fixed"}]as const].values()as never;return source[Symbol.iterator]().next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-own-next-pin',
    source:
      'function frames(error:Error){const cursor=new Set([error])[Symbol.iterator]();cursor.next=()=>({done:false,value:{stack:"fixed"}})as never;return cursor.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-next-rewrites-pin',
    source:
      'function frames(error:Error){return new Set([error])[Symbol.iterator]().next(Object.assign(error,{stack:"fixed"})as never).value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-prior-progress-pin',
    source:
      'function frames(error:Error){const cursor=new Set([error,{stack:"fixed"}])[Symbol.iterator]();cursor.next();return cursor.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-prior-stack-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return new Set([error])[Symbol.iterator]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-local-constructor-pin',
    source:
      'function frames(error:Error){class Set{constructor(_input:unknown){}[Symbol.iterator](){return[{stack:"fixed"}].values();}}return new Set([error])[Symbol.iterator]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-local-constructor-pin',
    source:
      'function frames(error:Error){class Map{constructor(_input:unknown){}[Symbol.iterator](){return[["fixed",{stack:"fixed"}]as const].values();}}return new Map([["failure",error]])[Symbol.iterator]().next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-local-symbol-shadow-pin',
    source:
      'function frames(error:Error){const Symbol={iterator:"values"as const};const source=new Set([error]);source.values=()=>[{stack:"fixed"}].values()as never;return source[Symbol.iterator]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-local-symbol-shadow-pin',
    source:
      'function frames(error:Error){const Symbol={iterator:"entries"as const};const source=new Map([["failure",error]]);source.entries=()=>[["fixed",{stack:"fixed"}]as const].values()as never;return source[Symbol.iterator]().next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-default-global-this-symbol',
    source:
      'function frames(error:Error){return[error][globalThis.Symbol.iterator]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-default-constructor-and-input-aliases',
    source:
      'function frames(error:Error){const Collection=Set;const input=[error];return new Collection(input)[Symbol.iterator]().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-default-replaced-first-key-pin',
    source:
      'function frames(error:Error){return new Map<string,{stack?:string}>([["failure",error],["failure",{stack:"fixed"}]])[Symbol.iterator]().next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native array and default iterator words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-iterator-forwarding.ts', source);
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

describe('shared native array and default iterator admission', () => {
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
