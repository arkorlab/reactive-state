import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Loose object equality preserves existing primitive-compatible structural bounds. */
const CASES = [
  {
    id: 'required-own-tag',
    source: 'function same(error:Error,other:{tag:string}){return error==other;}',
    invocation: 'same(new Error("ours"),{tag:"fixed"})',
    refused: false,
  },
  {
    id: 'selected-own-tag',
    source: 'function same({error,other}:{error:Error;other:{tag:string}}){return error!=other;}',
    invocation: 'same({error:new Error("ours"),other:{tag:"fixed"}})',
    refused: false,
  },
  {
    id: 'callable-object-shape',
    source: 'function same(error:Error,other:{():string}){return error==other;}',
    invocation: 'same(new Error("ours"),()=>"fixed")',
    refused: false,
  },
  {
    id: 'empty-shape-can-be-text',
    source: 'function same(error:Error,other:{}){return error==other;}',
    invocation: 'same(new Error("ours"),"Error: ours")',
    refused: true,
  },
  {
    id: 'length-shape-can-be-text',
    source: 'function same(error:Error,other:{length:number}){return error==other;}',
    invocation: 'same(new Error("ours"),"Error: ours")',
    refused: true,
  },
  {
    id: 'shared-optional-shape-can-be-text',
    source: 'function same(error:Error,other:{tag?:string;length?:number}){return error==other;}',
    invocation: 'same(new Error("ours"),"Error: ours")',
    refused: true,
  },
  {
    id: 'primitive-toString-shape',
    source: 'function same(error:Error,other:{toString():string}){return error==other;}',
    invocation: 'same(new Error("ours"),"Error: ours")',
    refused: true,
  },
  {
    id: 'written-replacement-stays-opaque',
    source:
      'function same(error:Error,other:{tag:string}){other="Error: ours" as never;return error==other;}',
    invocation: 'same(new Error("ours"),{tag:"fixed"})',
    refused: true,
  },
  {
    id: 'native-error-object-bound',
    source: 'function same(error:Error,other:Error){return error==other;}',
    invocation: 'same(new Error("ours"),new Error("other"))',
    refused: false,
  },
  {
    id: 'constructed-words-stay-local',
    source: 'function same(other:{}){return new Error("ours")==other;}',
    invocation: 'same("Error: ours")',
    refused: false,
  },
];

describe('typed object equality readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'recursive-error-members.ts', source);
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

describe('shared typed object equality', () => {
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
