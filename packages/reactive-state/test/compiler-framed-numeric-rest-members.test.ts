import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Written source values retain their selected runtime meaning. */
const CASES = [
  {
    id: 'required-error-prefix',
    source:
      "type Selected=[Error,...string[]][number];function frames(error:Selected){return typeof error==='string'?error:error.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'required-error-suffix',
    source:
      "type Selected=[...string[],Error][number];function frames(error:Selected){return typeof error==='string'?error:error.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'finite-rest-error',
    source:
      "type Selected=[...[Error,string]][number];function frames(error:Selected){return typeof error==='string'?error:error.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'named-rest-error',
    source:
      "type Selected=[first:Error,...rest:string[]][number];function frames(error:Selected){return typeof error==='string'?error:error.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'readonly-rest-error',
    source:
      "type Selected=(readonly [Error,...string[]])[number];function frames(error:Selected){return typeof error==='string'?error:error.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-rest-error',
    source:
      "type Selected=[...Error[]][number];function frames(error:Selected){return typeof error==='string'?error:error.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'data-prefix',
    source:
      "type Selected=[{stack:string},...string[]][number];function frames(error:Selected){return typeof error==='string'?error:error.stack;}",
    invocation: "frames({stack:'fixed'})",
    refused: false,
  },
  {
    id: 'data-suffix',
    source:
      "type Selected=[...string[],{stack:string}][number];function frames(error:Selected){return typeof error==='string'?error:error.stack;}",
    invocation: "frames({stack:'fixed'})",
    refused: false,
  },
  {
    id: 'finite-data-rest',
    source:
      "type Selected=[...[{stack:string},string]][number];function frames(error:Selected){return typeof error==='string'?error:error.stack;}",
    invocation: "frames({stack:'fixed'})",
    refused: false,
  },
  {
    id: 'literal-prefix-existing',
    source:
      "type Selected=[Error,...string[]][0];function frames(error:Selected){return typeof error==='string'?error:error.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'shadowed-error-data',
    source:
      "type Error={stack:string};type Selected=[Error,...string[]][number];function frames(error:Selected){return typeof error==='string'?error:error.stack;}",
    invocation: "frames({stack:'fixed'})",
    refused: false,
  },
  {
    id: 'plain-finite-error',
    source:
      "type Selected=[Error,string][number];function frames(error:Selected){return typeof error==='string'?error:error.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
] as const;

describe('numeric tuple rest members readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-write-error.ts', source);
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

describe('numeric tuple rest members shared modules', () => {
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
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
