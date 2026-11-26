import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Missing Map values and source-known get spreads keep the selected native result. */
const CASES = [
  {
    id: 'missing-other-value-retains-first',
    source:
      "function frames(error:Error){return new Map([['first',error],['other'] as never]).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'missing-other-entry-value-slot',
    source:
      "function frames(error:Error){return new Map([['first',error],['other'] as never]).entries().next().value![1].stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'missing-other-whole-map-alias',
    source:
      "function frames(error:Error){const values=new Map([['first',error],['other'] as never]);return values.values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'missing-other-default-iterator',
    source:
      "function frames(error:Error){return new Map([['first',error],['other'] as never])[Symbol.iterator]().next().value![1].stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'first-missing-later-error-overwrite',
    source:
      "function frames(error:Error){return new Map<string,Error>([['first'] as never,['first',error],['other'] as never]).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-unrelated-entry-retains-first',
    source:
      "function frames(error:Error){return new Map([['first',error],[] as never]).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'missing-value-same-key-clears-error',
    source:
      "function frames(error:Error){try{return new Map([['first',error],['first'] as never]).values().next().value!.stack;}catch{return'fixed';}}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'empty-clears-undefined-first-key',
    source:
      "function frames(error:Error){try{return new Map<unknown,Error>([[undefined,error],[] as never]).values().next().value!.stack;}catch{return'fixed';}}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'missing-value-keeps-ordinary-data',
    source:
      "function frames(error:Error){return new Map([['first',{stack:'fixed'}],['other'] as never]).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'explicit-undefined-other-pin',
    source:
      "function frames(error:Error){return new Map<string,Error|undefined>([['first',error],['other',undefined]]).values().next().value!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'get-reported-spread-safe',
    source:
      "function frames(error:Error){return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get(...(['safe'] as const))!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'get-whole-tuple-alias-safe',
    source:
      "function frames(error:Error){const keys=['safe'] as const;return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get(...keys)!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'get-nested-spread-safe',
    source:
      "function frames(error:Error){return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get(...([...['safe']] as const))!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'get-spread-selected-error-pin',
    source:
      "function frames(error:Error){return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get(...(['bad'] as const))!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'get-exposed-tuple-retains-error-pin',
    source:
      "function frames(error:Error){const keys=['safe'] as [string];keys[0]='bad';return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get(...keys)!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'get-borrowed-safe-pin',
    source:
      "function frames(error:Error){return Map.prototype.get.call(new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]),...(['safe'] as const))!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'get-own-safe-pin',
    source:
      "function frames(error:Error){const values=new Map<string,{stack?:string}>([['bad',error]]);values.get=()=>({stack:'fixed'});return values.get(...(['bad'] as const))!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'get-nonspread-safe-pin',
    source:
      "function frames(error:Error){return new Map<string,{stack?:string}>([['bad',error],['safe',{stack:'fixed'}]]).get('safe')!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('finite Map entry and argument readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'borrowed-map-get.ts', source);
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

describe('shared finite Map entry and argument results', () => {
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
