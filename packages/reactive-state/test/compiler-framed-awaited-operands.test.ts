import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Awaited keeps every settled constituent, so no Error-only projection stands for a conditional operand. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-awaited-union-check',
    source:
      'type Data={stack:string};type Failure=Awaited<Error|Data> extends Error?Data:Error;function readFrames(value:Failure){return value.stack;}',
    invocation: 'readFrames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'awaited-promise-union-check',
    source:
      'type Data={stack:string};type Failure=Awaited<Promise<Error>|Data> extends Error?Data:Error;function readFrames(value:Failure){return value.stack;}',
    invocation: 'readFrames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'awaited-alias-union-check',
    source:
      'type Data={stack:string};type Settled=Awaited<Error|Data>;type Failure=Settled extends Error?Data:Error;function readFrames(value:Failure){return value.stack;}',
    invocation: 'readFrames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'awaited-unsettled-union-check',
    source:
      'type Thenable={then(onfulfilled:(value:{stack:string})=>unknown):unknown};type Failure=Awaited<Error|Thenable> extends Error?{stack:string}:Error;function readFrames(value:Failure){return value.stack;}',
    invocation: 'readFrames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'awaited-only-error-data',
    source:
      'type Data={stack:string};type Failure=Awaited<Promise<Error>> extends Error?Data:Error;function readFrames(value:Failure){return value.stack;}',
    invocation: 'readFrames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'awaited-primitive-check',
    source:
      'type Data={stack:string};type Failure=Awaited<Promise<string>> extends Error?Error:Data;function readFrames(value:Failure){return value.stack;}',
    invocation: 'readFrames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'awaited-member-object',
    source:
      'type Failure=Awaited<{inner:Error}>;function readFrames(value:Failure){return value.inner.stack;}',
    invocation: 'readFrames({inner:new Error("ours")})',
    refused: true,
  },
  {
    id: 'awaited-promise-member-object',
    source:
      'type Failure=Awaited<Promise<{inner:Error}>>;function readFrames(value:Failure){return value.inner.stack;}',
    invocation: 'readFrames({inner:new Error("ours")})',
    refused: true,
  },
];

describe('awaited operand readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'awaited-operands.ts', source);
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

describe('shared awaited operand admissions', () => {
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
