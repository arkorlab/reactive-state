import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
const CASES = [
  {
    group: 'descriptor',
    id: 'define-property-error',
    source:
      'function frames(error:Error){return Object.defineProperty({failure:{stack:"fixed"}},"failure",{value:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'descriptor',
    id: 'define-properties-error',
    source:
      'function frames(error:Error){return Object.defineProperties({failure:{stack:"fixed"}},{failure:{value:error}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'descriptor',
    id: 'defined-result-alias',
    source:
      'function frames(error:Error){const box=Object.defineProperty({failure:{stack:"fixed"}},"failure",{value:error});return box.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'descriptor',
    id: 'defined-nested-path',
    source:
      'function frames(error:Error){return Object.defineProperty({box:{failure:{stack:"fixed"}}},"box",{value:{failure:error}}).box.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'descriptor',
    id: 'defined-data',
    source:
      'function frames(error:Error){return Object.defineProperty({failure:{stack:"fixed"}},"failure",{value:{stack:"data"}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'descriptor',
    id: 'defined-unrelated-key',
    source:
      'function frames(error:Error){return Object.defineProperty({failure:{stack:"fixed"}},"other",{value:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'descriptor',
    id: 'defined-shadow',
    source:
      'function frames(error:Error){const Object={defineProperty:(target:{failure:{stack:string}},_key:string,_descriptor:unknown)=>target};return Object.defineProperty({failure:{stack:"fixed"}},"failure",{value:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'descriptor',
    id: 'defined-own-words',
    source:
      'function frames(error:Error){return Object.defineProperty({failure:{message:"fixed"}},"failure",{value:new Error("ours")}).failure.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'descriptor',
    id: 'defined-own-frames',
    source:
      'function frames(error:Error){return Object.defineProperties({failure:{stack:"fixed"}},{failure:{value:new Error("ours")}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'map',
    id: 'map-get-error',
    source:
      'function frames(error:Error){return new Map<string,Error>([["failure",error]]).get("failure")!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'map',
    id: 'map-alias-error',
    source:
      'function frames(error:Error){const values=new Map<string,Error>([["failure",error]]);return values.get("failure")!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'map',
    id: 'map-typed-parameter',
    source: 'function frames(values:Map<string,Error>){return values.get("failure")!.stack;}',
    invocation: 'frames(new Map([["failure",new Error("ours")]]))',
    refused: true,
  },
  {
    group: 'map',
    id: 'map-data',
    source:
      'function frames(error:Error){return new Map([["failure",{stack:"data"}]]).get("failure")!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'map',
    id: 'map-other-key',
    source:
      'function frames(error:Error){return new Map([["safe",{stack:"data"}],["failure",error]]).get("safe")!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'map',
    id: 'map-shadow',
    source:
      'function frames(error:Error){const Map=class{constructor(_entries:unknown){}get(_key:string){return{stack:"data"};}};return new Map([["failure",error]]).get("failure").stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'map',
    id: 'map-own-get',
    source:
      'function frames(error:Error){const values=new Map<string,Error>([["failure",error]]);values.get=()=>({stack:"data"}as Error);return values.get("failure")!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'map',
    id: 'map-own-words',
    source:
      'function frames(error:Error){return new Map([["failure",new Error("ours")]]).get("failure")!.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'map',
    id: 'map-own-frames',
    source:
      'function frames(error:Error){return new Map([["failure",new Error("ours")]]).get("failure")!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
] as const;

describe('descriptor-map readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'source-writes.ts', source);
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

describe('descriptor-map shared modules', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const refusal = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [refusal] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
