import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Async filter predicates retain possible parameter elements when exact compaction is unavailable. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
  readonly files?: Readonly<Record<string, string>>;
}

const CASES: readonly Case[] = [
  {
    id: 'parameter-false',
    source: 'function frames(errors:Error[]){return errors.filter(async()=>false)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'parameter-zero',
    source: 'function frames(errors:Error[]){return errors.filter(async()=>0)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'parameter-null',
    source: 'function frames(errors:Error[]){return errors.filter(async()=>null)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'parameter-undefined',
    source: 'function frames(errors:Error[]){return errors.filter(async()=>undefined)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'parameter-empty',
    source: 'function frames(errors:Error[]){return errors.filter(async()=>"")[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'parameter-void',
    source: 'function frames(errors:Error[]){return errors.filter(async()=>void 0)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'readonly-parameter',
    source:
      'function frames(errors:readonly Error[]){return errors.filter(async()=>false)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'source-alias',
    source:
      'function frames(errors:Error[]){const input=errors;return input.filter(async()=>false)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'source-chain',
    source:
      'function frames(errors:Error[]){const input=errors;const alias=input;return alias.filter(async()=>false)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'negated-body',
    source: 'function frames(errors:Error[]){return errors.filter(async()=>!true)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'rest-parameter',
    source: 'function frames(...errors:Error[]){return errors.filter(async()=>false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-call',
    source:
      'function frames(errors:Error[]){return(Array.prototype.filter.call(errors,async()=>false)as Error[])[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'borrowed-apply',
    source:
      'function frames(errors:Error[]){return(Array.prototype.filter.apply(errors,[async()=>false])as Error[])[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'reflect-apply',
    source:
      'function frames(errors:Error[]){return(Reflect.apply(Array.prototype.filter,errors,[async()=>false])as Error[])[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'parameter-message',
    source: 'function frames(errors:Error[]){return errors.filter(async()=>false)[0]!.message;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'pin-async-true',
    source: 'function frames(errors:Error[]){return errors.filter(async()=>true)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'pin-async-truthy',
    source: 'function frames(errors:Error[]){return errors.filter(async()=>1)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'pin-async-block',
    source:
      'function frames(errors:Error[]){return errors.filter(async()=>{return false;})[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'pin-sync-false',
    source: 'function frames(errors:Error[]){return errors.filter(()=>false)[0]?.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: false,
  },
  {
    id: 'pin-sync-undefined',
    source: 'function frames(errors:Error[]){return errors.filter(()=>undefined)[0]?.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'pin-plain-data',
    source:
      'function frames(errors:{stack:string}[]){return errors.filter(async()=>false)[0]!.stack;}',
    invocation: 'frames([{stack:"fixed"}])',
    refused: false,
  },
  {
    id: 'pin-literal',
    source: 'function frames(error:Error){return[error].filter(async()=>false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'pin-own-filter',
    source:
      'function frames(){const input={filter(_predicate:(value:Error)=>Promise<boolean>){return[{stack:"fixed"}];}};return input.filter(async()=>false)[0]!.stack;}',
    invocation: 'frames()',
    refused: true,
  },
];

describe('async filter fallback readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'filter-results.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('shared async filter fallback admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, files }) => {
    const app = await application({
      ...files,
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
