import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'set-values-error',
    source: 'function frames(error:Error){return new Set([error]).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-values-error',
    source:
      'function frames(error:Error){return new Map([["key",error]]).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-keys-error',
    source:
      'function frames(error:Error){return new Map([[error,"fixed"]]).keys().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-entries-error',
    source:
      'function frames(error:Error){return new Set([error]).entries().next().value![0].stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-entries-error',
    source:
      'function frames(error:Error){return new Map([["key",error]]).entries().next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-set-constructor-alias',
    source:
      'function frames(error:Error){const Collection=Set;return new Collection([error]).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'iterator-const-alias',
    source:
      'function frames(error:Error){const values=new Set([error]).values();const cursor=values;return cursor.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-first-key-replaced-value',
    source:
      'function frames(error:Error){return new Map<string,{stack?:string}>([["key",{stack:"fixed"}],["key",error]]).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-first-data',
    source:
      'function frames(error:Error){return new Set([{stack:"fixed"},error]).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-first-data',
    source:
      'function frames(error:Error){return new Map<string,{stack?:string}>([["a",{stack:"fixed"}],["b",error]]).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'set-own-values-data',
    source:
      'function frames(error:Error){const items=new Set([error]);items.values=()=>[{stack:"fixed"}].values() as never;return items.values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'iterator-own-next-data',
    source:
      'function frames(error:Error){const cursor=new Set([error]).values();cursor.next=()=>({done:false,value:{stack:"fixed"}}) as never;return cursor.next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-set-shadow',
    source:
      'function frames(error:Error){class Set{constructor(_values:unknown){}values(){return [{stack:"fixed"}].values();}}return new Set([error]).values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-error-iterator-words',
    source:
      'function frames(){return new Set([new Error("fixed")]).values().next().value!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'conditional-own-values-retains-native',
    source:
      'function frames(error:Error,flag:boolean){const items=new Set([error]);if(flag)items.values=()=>[{stack:"fixed"}].values() as never;return items.values().next().value!.stack;}',
    invocation: 'frames(new Error("ours"),false)',
    refused: true,
  },
  {
    id: 'native-iterator-ignored-next-argument',
    source:
      'function frames(error:Error){return new Map([["key",{stack:"fixed"}]]).values().next(error as never).value!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native collection iterator readers', () => {
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

describe('shared native collection iterators', () => {
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
