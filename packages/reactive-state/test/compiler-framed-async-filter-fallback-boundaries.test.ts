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
    id: 'owner-prefix-prepare-data',
    source:
      'function frames(error:Error){function collect(errors:Error[],prepare:()=>void){prepare();return errors.filter(async()=>false)[0]!.stack;}return collect([error],()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'receiver-iife-data',
    source:
      'function frames(error:Error){return(()=>{Object.assign(error,{stack:"fixed"});return[error];})().filter(async()=>false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'receiver-written-getter-data',
    source:
      'function frames(error:Error){const holder={get errors(){Object.assign(error,{stack:"fixed"});return[error];}};return holder.errors.filter(async()=>false)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'predicate-primitive-alias',
    source:
      'function frames(errors:Error[]){const keep=false;return errors.filter(async()=>keep)[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'owner-default-empty-data',
    source:
      'function frames(_error:Error,errors:Error[]=[]){return errors.filter(async()=>false)[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'captured-receiver-data',
    source:
      'function frames(error:Error){const errors=[error];function collect(){return errors.filter(async()=>false)[0]!.stack;}Object.assign(error,{stack:"fixed"});return collect();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'getter-bridge-async-false',
    source:
      'function frames(error:Error){function collect(input:{errors:Error[]}){return input.errors.filter(async()=>false)[0]!.stack;}return collect({get errors(){Object.assign(error,{stack:"fixed"});return[error];}});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'getter-bridge-async-true-legacy',
    source:
      'function frames(error:Error){function collect(input:{errors:Error[]}){return input.errors.filter(async()=>true)[0]!.stack;}return collect({get errors(){Object.assign(error,{stack:"fixed"});return[error];}});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('async filter fallback boundaries readers', () => {
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

describe('shared async filter fallback boundaries admissions', () => {
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
