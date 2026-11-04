import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'array-some-error',
    source:
      'function frames(error:Error){return [error].some(value=>value.stack!.includes("Firefox"));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-every-error',
    source:
      'function frames(error:Error){return [error].every(value=>value.stack!.includes("Firefox"));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-filter-error',
    source:
      'function frames(error:Error){return [error].filter(value=>value.stack!.includes("Firefox")).length;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-map-error',
    source: 'function frames(error:Error){return [error].map(value=>value.stack).join("");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-written-element-type',
    source:
      'function frames(error:Error){const items:Error[]=[error];return items.some(value=>value.stack!.includes("Firefox"));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-destructured-callback',
    source:
      'function frames(error:Error){return [{failure:error}].some(({failure})=>failure.stack!.includes("Firefox"));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-local-callback-function',
    source:
      'function frames(error:Error){return [error].some(function(value){return value.stack!.includes("Firefox");});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-callback-data',
    source:
      'function frames(){return [{stack:"fixed"}].some(value=>value.stack.includes("Firefox"));}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'array-callback-local-written-words',
    source:
      'function frames(){return [new Error("fixed")].some(value=>value.message.includes("fixed"));}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'array-callback-index-parameter',
    source: 'function frames(error:Error){return [error].some((_value,index)=>index>0);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'array-own-some-ignores-callback',
    source:
      'function frames(error:Error){const items=[error];items.some=()=>false;return items.some(value=>value.stack!.includes("Firefox"));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'array-empty-no-callback',
    source:
      'function frames(){return ([] as Error[]).some(value=>value.stack!.includes("Firefox"));}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'array-callback-typed-local-words',
    source:
      'function frames(){const items:Error[]=[new Error("fixed")];return items.some(value=>value.message.includes("fixed"));}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'array-callback-typed-literal-data',
    source:
      'function frames(){const items:Error[]=[{name:"Data",message:"fixed",stack:"fixed"}];return items.some(value=>value.stack!.includes("Firefox"));}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'array-parameter-element-type',
    source:
      'function frames(items:Error[]){return items.some(value=>value.stack!.includes("Firefox"));}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
];

describe('native array callback origins readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'blob-parts.ts', source);
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

describe('shared native array callback origins', () => {
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
