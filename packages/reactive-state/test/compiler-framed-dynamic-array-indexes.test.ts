import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'typed-error-array',
    source: 'function frames(values:Error[],i:number){return values[i]!.stack;}',
    refused: true,
    invocation: 'frames([new Error("ours")],0)',
  },
  {
    id: 'readonly-error-array',
    source: 'function frames(values:ReadonlyArray<Error>,i:number){return values[i]!.message;}',
    refused: true,
    invocation: 'frames([new Error("ours")],0)',
  },
  {
    id: 'default-generic-array',
    source:
      'type Batch<T=Error>=readonly T[];function frames(values:Batch,i:number){return values[i]!.stack;}',
    refused: true,
    invocation: 'frames([new Error("ours")],0)',
  },
  {
    id: 'dynamic-error-tuple',
    source:
      'function frames(values:readonly [{stack:string},Error],i:number){return values[i]!.stack;}',
    refused: true,
    invocation: 'frames([{stack:"fixed"},new Error("ours")],1)',
  },
  {
    id: 'dynamic-literal-array',
    source: 'function frames(error:Error,i:number){return [{stack:"fixed"},error][i]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"),1)',
  },
  {
    id: 'locally-made-words',
    source: 'function frames(i:number){return [new Error("ours")][i]!.message;}',
    refused: false,
    invocation: 'frames(0)',
  },
  {
    id: 'ordinary-data-array',
    source: 'function frames(values:{stack:string}[],i:number){return values[i]!.stack;}',
    refused: false,
    invocation: 'frames([{stack:"fixed"}],0)',
  },
  {
    id: 'nested-array-not-error',
    source:
      'function frames(values:Error[][],i:number){return (values[i] as unknown as {stack:string}).stack;}',
    refused: false,
    invocation: 'frames([[new Error("ours")]],0)',
  },
  {
    id: 'known-safe-tuple-position',
    source: 'function frames(values:readonly [{stack:string},Error]){return values[0].stack;}',
    refused: false,
    invocation: 'frames([{stack:"fixed"},new Error("ours")])',
  },
  {
    id: 'known-error-tuple-position',
    source: 'function frames(values:readonly [{stack:string},Error]){return values[1].stack;}',
    refused: true,
    invocation: 'frames([{stack:"fixed"},new Error("ours")])',
  },
  {
    id: 'local-error-shadow',
    source:
      'class Error{stack="fixed";}function frames(values:Error[],i:number){return values[i]!.stack;}',
    refused: false,
    invocation: 'frames([new Error()],0)',
  },
  {
    id: 'own-join-does-not-change-element',
    source:
      'function frames(error:Error,i:number){const values=[error];values.join=()=>"fixed";return values[i]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"),0)',
  },
  {
    id: 'finite-index-error-position',
    source:
      'function frames(values:readonly [{stack:string},Error,{stack:string}],i:0|1){return values[i].stack;}',
    refused: true,
    invocation: 'frames([{stack:"fixed"},new Error("ours"),{stack:"also"}],1)',
  },
  {
    id: 'finite-index-only-data-positions',
    source:
      'function frames(values:readonly [{stack:string},Error,{stack:string}],i:0|2){return values[i].stack;}',
    refused: false,
    invocation: 'frames([{stack:"fixed"},new Error("ours"),{stack:"also"}],0)',
  },
];

describe('dynamic-array-indexes readers', () => {
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

describe('shared dynamic-array-indexes', () => {
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
