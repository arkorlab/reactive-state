import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Unknown selector candidates retain explicit Error annotations until their results are source-known. */
const CASES = [
  {
    id: 'pop-exposure-retains-outer-error-assertion',
    source:
      'function frames(error:unknown){const values=[new Error("fixed"),error];values.length;return (values.pop()as Error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'weakmap-unknown-value-retains-outer-error-assertion',
    source:
      'function frames(error:unknown){const key={};return (new WeakMap<object,unknown>([[key,error]]).get(key)as Error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'pop-plain-selected-message-data',
    source:
      'function frames(){const values=[new Error("fixed"),{message:"fixed"}];values.length;return values.pop()!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'weakmap-local-made-words-data',
    source:
      'function frames(){const key={};return new WeakMap([[key,new Error("fixed")]]).get(key)!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'map-unknown-value-retains-outer-error-assertion',
    source:
      'function frames(error:unknown){return(new Map<string,unknown>([["key",error]]).get("key")as Error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'map-explicit-native-error-value',
    source:
      'function frames(error:any){return new Map<string,Error>([["key",error]]).get("key")!.message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'weakmap-explicit-native-error-value',
    source:
      'function frames(error:any){const key={};return new WeakMap<object,Error>([[key,error]]).get(key)!.message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'pop-all-local-asserted-words',
    source:
      'function frames(){const values=[new Error("first"),new Error("fixed")];values.length;return(values.pop()as Error).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'pop-local-and-literal-data-asserted-words',
    source:
      'function frames(){const values=[new Error("fixed"),{message:"fixed"}];values.length;return(values.pop()as Error).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'weakmap-literal-data-asserted-words',
    source:
      'function frames(){const key={};return(new WeakMap([[key,{message:"fixed"}]]).get(key)as Error).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'map-literal-data-asserted-words',
    source:
      'function frames(){return(new Map([["key",{message:"fixed"}]]).get("key")as Error).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'map-local-error-alias-asserted-words',
    source:
      'function frames(){const local=new Error("fixed");return(new Map([["key",local]]).get("key")as Error).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'own-pop-local-asserted-words',
    source:
      'function frames(){const values:unknown[]=[];values.pop=()=>new Error("fixed");return(values.pop()as Error).message;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'own-map-literal-data-asserted-words',
    source:
      'function frames(){const values=new Map<string,unknown>();values.get=()=>({message:"fixed"});return(values.get("key")as Error).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'pop-unknown-spread-retains-assertion',
    source:
      'function frames(errors:unknown[]){const values=[new Error("fixed"),...errors];values.length;return(values.pop()as Error).message;}',
    invocation: 'frames([new Error("supplied")])',
    refused: true,
  },
  {
    id: 'shift-exposure-retains-outer-error-assertion',
    source:
      'function frames(error:unknown){const values=[error,new Error("fixed")];values.length;return(values.shift()as Error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
];

describe('map removal assertion readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'map-removal-assertions.ts', source);
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

describe('shared map removal assertions', () => {
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
