import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A literal's later setter keeps the getter of its name, whose value JSON reads and serializes. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-getter-setter-tojson',
    source:
      'function frames(error:Error){return JSON.stringify({get toJSON(){return()=>error;},set toJSON(_value:unknown){}},["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'aliased-getter-setter-tojson',
    source:
      'function frames(error:Error){const holder={get toJSON(){return()=>error;},set toJSON(_value:unknown){}};return JSON.stringify(holder,["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assigned-getter-setter-tojson',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign({},{get toJSON(){return()=>error;},set toJSON(_value:unknown){}}),["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'descriptor-value-pair',
    source:
      'function frames(error:Error){return JSON.stringify(Object.defineProperty({},"failure",{get value(){return error;},set value(_value:unknown){},enumerable:true}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plural-descriptor-value-pair',
    source:
      'function frames(error:Error){return JSON.stringify(Object.defineProperties({},{failure:{get value(){return error;},set value(_value:unknown){},enumerable:true}}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'setter-then-getter-tojson',
    source:
      'function frames(error:Error){return JSON.stringify({set toJSON(_value:unknown){},get toJSON(){return()=>error;}},["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'pair-returning-data',
    source:
      'function frames(error:Error){return JSON.stringify({get toJSON(){return()=>({stack:"fixed"});},set toJSON(_value:unknown){}},["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'setter-only-tojson',
    source:
      'function frames(error:Error){return JSON.stringify({set toJSON(_value:unknown){},failure:{stack:"fixed"}},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'spread-setter-replaces-getter',
    source:
      'function frames(error:Error){const setter={set toJSON(_value:unknown){}};return JSON.stringify({get toJSON(){return()=>error;},...setter},["stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'descriptor-setter-only-value',
    source:
      'function frames(error:Error){return JSON.stringify(Object.defineProperty({failure:error},"failure",{set value(_value:unknown){},enumerable:true,writable:true}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('jSON accessor pair readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'json-accessor-pairs.ts', source);
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

describe('shared JSON accessor pair admissions', () => {
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
