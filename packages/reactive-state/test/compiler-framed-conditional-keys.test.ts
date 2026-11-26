import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Written finite key selections retain only their syntax-known member possibilities. */
const CASES = [
  {
    id: 'false-conditional-name',
    source: "function frames(error:Error){return error[false?'stack':'name'];}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'constant-conditional-name',
    source:
      "const flag=false;const alias=flag;function frames(error:Error){return error[alias?'stack':'name'];}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'nested-conditional-name',
    source: "function frames(error:Error){return error[true?(false?'stack':'name'):'stack'];}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'true-conditional-stack',
    source: "function frames(error:Error){return error[true?'stack':'name'];}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-conditional-stack',
    source: "function frames(error:Error,flag:boolean){return error[flag?'stack':'name'];}",
    invocation: 'frames(new Error("ours"),true)',
    refused: true,
  },
  {
    id: 'shadowed-conditional-stack',
    source:
      "const flag=false;function frames(error:Error){const flag=true;return error[flag?'stack':'name'];}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-data-member',
    source:
      "function frames(error:{stack:string;name:string}){return error[false?'stack':'name'];}",
    invocation: 'frames({stack:"fixed",name:"fixed"})',
    refused: false,
  },
];

describe('constant conditional keys readers', () => {
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

describe('shared constant conditional keys', () => {
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
