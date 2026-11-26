import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native instance utilities and erased factory prefixes retain source-written errors. */
const CASES = [
  {
    id: 'prefix-third-typed-error',
    source:
      'function factory(a:number,b:number,error:Error){return error;}function read(error:Error){return String(factory(...[0,0,error] as [number,number,Error]));}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'prefix-third-typed-data',
    source:
      "function factory(a:number,b:number,value:{stack:string}){return value;}function read(){return String(factory(...[0,0,{stack:'fixed'}] as [number,number,{stack:string}]));}",
    invocation: 'read()',
    refused: false,
  },
];

describe('factory prefix readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'instance-factory.ts', source);
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

describe('shared factory prefix results', () => {
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

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
