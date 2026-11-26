import { appendFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-written patterns retain only the selected array element values. */
const CASES = [
  {
    id: 'array-pattern-join',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];[values[0]]=[error];return values.join();}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'object-pattern-at',
    source:
      'function frames(error:Error){const values:unknown[]=[{stack:"fixed"}];({a:values[0]}={a:error});return (values.at(0) as Error).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-pattern-dynamic',
    source:
      'function frames(error:Error,index:number){const values:unknown[]=[{stack:"fixed"}];({a:[values[0]]}={a:[error]});return (values[index] as Error).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"),0)',
  },
  {
    id: 'loop-element-join',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];for(values[0] of [error]){}return values.join();}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'loop-pattern-at',
    source:
      'function frames(error:Error){const values:unknown[]=[{stack:"fixed"}];for([values[0]] of [[error]]){}return (values.at(0) as Error).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-array-alias-pattern',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];const alias=values;[alias[0]]=[error];return values.join();}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'selected-other-index',
    source:
      'function frames(error:Error){const values:unknown[]=[{stack:"fixed"},null];[values[1]]=[error];return (values.at(0) as {stack:string}).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ordinary-pattern-data',
    source:
      'function frames(){const values:unknown[]=[""];[values[0]]=["fixed"];return values.join();}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'unselected-pattern',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];if(false)[values[0]]=[error];return values.join();}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-literal-loop',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];for(values[0] of []){}return values.join();}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'later-pattern',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];const text=values.join();[values[0]]=[error];return text;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-error-words',
    source:
      'function frames(){const values:unknown[]=["fixed"];[values[0]]=[new Error("ours")];return values.join();}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'ordinary-loop-data',
    source:
      'function frames(){const values:unknown[]=[""];for(values[0] of ["fixed"]){}return values.join();}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'other-lexical-array',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];{const values:unknown[]=[""];[values[0]]=[error];}return values.join();}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'extra-object-pattern-join',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];({a:values[0]}={a:error});return values.join();}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'extra-typed-object-pattern',
    source:
      'function frames(box:{error:Error}){const values:unknown[]=["fixed"];({error:values[0]}=box);return values.join();}',
    refused: true,
    invocation: 'frames({error:new Error("ours")})',
  },
  {
    id: 'extra-typed-loop-element',
    source:
      'function frames(errors:Error[]){const values:unknown[]=["fixed"];for(values[0] of errors){}return values.join();}',
    refused: true,
    invocation: 'frames([new Error("ours")])',
  },
  {
    id: 'array-default-source-write',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];const {a=values.join()}=(values[0]=error,{} as {a?:string});return a;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'array-default-source-other',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];const other:unknown[]=[];const {a=values.join()}=(other[0]=error,{} as {a?:string});return a;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

/** Actual compiler reasons remain separate from the reader classification. */
function record(source: string, reasons: readonly string[]): void {
  const path = process.env['PATTERN_ARRAY_OBSERVATIONS'];
  if (path !== undefined) appendFileSync(path, `${JSON.stringify({ source, reasons })}\n`);
}

describe('pattern-array readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'pattern-array.ts', source);
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

describe('shared pattern-array', () => {
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
    record(source, reasons);

    expect(reasons.length > 0).toBe(refused);
  });
});
