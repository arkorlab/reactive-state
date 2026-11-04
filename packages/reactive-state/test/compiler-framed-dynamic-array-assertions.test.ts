import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A possible local Error must not mask an explicit Error assertion on another selected value. */
const CASES = [
  {
    id: 'opaque-mixed-array-asserted-error',
    source:
      'function frames(error:unknown,index:number){const values=[new Error("fixed"),error];return (values[index] as Error).message;}',
    invocation: 'frames(new Error("ours"),1)',
    refused: true,
  },
  {
    id: 'finite-mixed-array-asserted-error',
    source:
      'function frames(error:unknown,index:0|1){const values=[new Error("fixed"),error];return (values[index] as Error).message;}',
    invocation: 'frames(new Error("ours"),1)',
    refused: true,
  },
  {
    id: 'local-made-dynamic-message',
    source:
      'function frames(index:number){const values=[new Error("fixed")];return values[index]!.message;}',
    invocation: 'frames(0)',
    refused: false,
  },
  {
    id: 'local-made-fixed-frames',
    source:
      'function frames(){const values:readonly[Error]=[new Error("fixed")];return values[0].stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'ordinary-dynamic-data',
    source:
      'function frames(index:number){const values=[{message:"fixed"}];return values[index]!.message;}',
    invocation: 'frames(0)',
    refused: false,
  },
  {
    id: 'finite-only-data-positions',
    source:
      'function frames(error:Error,index:0|2){const values:readonly[{message:string},Error,{message:string}]=[{message:"fixed"},error,{message:"other"}];return values[index].message;}',
    invocation: 'frames(new Error("ours"),0)',
    refused: false,
  },
  {
    id: 'known-error-tuple-position',
    source:
      'function frames(error:Error){const values:readonly[{message:string},Error]=[{message:"fixed"},error];return values[1].message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-error-shadow-data',
    source:
      'class Error{message="fixed"}function frames(index:number){const values=[new Error()];return values[index]!.message;}',
    invocation: 'frames(0)',
    refused: false,
  },
];

describe('dynamic array assertion readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-noinfer.ts', source);
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

describe('shared dynamic array assertion results', () => {
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
