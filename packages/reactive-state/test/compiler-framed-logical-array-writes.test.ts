import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'nullish-element-write',
    source:
      'function frames(error:Error){const values:unknown[]=[null];values[0]??=error;return values.join();}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'or-element-write',
    source:
      'function frames(error:Error){const values:unknown[]=[""];values[0]||=error;return values.join();}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'and-element-write',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];values[0]&&=error;return values.join();}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'logical-whole-alias',
    source:
      'function frames(error:Error){const values:unknown[]=[""];const alias=values;alias[0]||=error;return values.join();}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'prior-write-loses-initial-value',
    source:
      'function frames(error:Error){const values:unknown[]=[{stack:"fixed"}];values[0]=null;values[0]??=error;return values.join();}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-initial-value',
    source:
      'function frames(error:Error,first:unknown){const values=[first];values[0]||=error;return values.join();}',
    refused: true,
    invocation: 'frames(new Error("ours"),"")',
  },
  {
    id: 'skipped-nullish-zero',
    source:
      'function frames(error:Error){const values:unknown[]=[0];values[0]??=error;return values.join();}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'skipped-or-text',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];values[0]||=error;return values.join();}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'skipped-and-false',
    source:
      'function frames(error:Error){const values:unknown[]=[false];values[0]&&=error;return values.join();}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'skipped-or-object',
    source:
      'function frames(error:Error){const values:unknown[]=[{stack:"fixed"}];values[0]||=error;return values.join();}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unselected-logical-write',
    source:
      'function frames(error:Error){const values:unknown[]=[null];if(false)values[0]??=error;return values.join();}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-made-words',
    source:
      'function frames(){const values:unknown[]=[null];values[0]??=new Error("ours");return values.join();}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'ordinary-logical-data',
    source:
      'function frames(){const values:unknown[]=[""];values[0]||="fixed";return values.join();}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'logical-default-source-null',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];const {a=(values[0]??=error,values.join())}=(values[0]=null,{} as {a?:string});return a;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'logical-default-source-other',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];const other:unknown[]=["x"];const {a=(values[0]??=error,values.join())}=(other[0]=null,{} as {a?:string});return a;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('logical-array-writes readers', () => {
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

describe('shared logical-array-writes', () => {
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
