import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-visible error inputs retain their runtime observations and lexical identity. */
const CASES = [
  {
    id: 'element-error-key',
    source:
      "function frames(error:Error){return ({'Error: ours':1} as Record<string,number>)[error as never];}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'object-error-key',
    source: 'function frames(error:Error){return Object.keys({[error as never]:1}).length;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'caught-error-key',
    source:
      "function frames(){try{JSON.parse('bad');}catch(error){return ({fixed:1} as Record<string,number>)[error as never];}}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'binding-error-key',
    source:
      'function frames(error:Error){const {[error as never]:value}=({fixed:1} as Record<string,number>);return value;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plain-data-key',
    source: "function frames(){return {fixed:1}['fixed'];}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'locally-made-key',
    source:
      "function frames(){return ({fixed:1} as Record<string,number>)[new Error('ours') as never];}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'local-error-shadow-key',
    source:
      "class Error{toString(){return 'fixed';}}function frames(error:Error){return ({fixed:1} as Record<string,number>)[error as never];}",
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'erased-type-key',
    source: "function frames(error:Error){type Box={[error as never]:number};return 'fixed';}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('error property key coercions readers', () => {
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

describe('shared error property key coercions', () => {
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
