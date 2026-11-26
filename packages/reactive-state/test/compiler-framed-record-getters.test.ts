import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A record's getter supplies what it returns to the native query and header conversions. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-params-getter',
    source:
      'function frames(error:Error){return new URLSearchParams({get x(){return error as never;}}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'headers-getter',
    source:
      'function frames(error:Error){return new Headers({get x(){return error as never;}}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'getter-setter-pair',
    source:
      'function frames(error:Error){return new URLSearchParams({get x(){return error as never;},set x(_value:never){}}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'setter-getter-pair',
    source:
      'function frames(error:Error){return new URLSearchParams({set x(_value:never){},get x(){return error as never;}}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'saved-getter-record',
    source:
      'function frames(error:Error){const record={get x(){return error as never;}};return new URLSearchParams(record).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-getter-record',
    source:
      'function frames(error:Error){return new URLSearchParams({...{get x(){return error as never;}}}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'getter-array-words',
    source:
      'function frames(error:Error){return new URLSearchParams({get x(){return[error]as never;}}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'setter-only-record',
    source:
      'function frames(error:Error){return new URLSearchParams({set x(_value:never){}}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'getter-data-return',
    source:
      'function frames(error:Error){return new URLSearchParams({get x(){return"fixed";}}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'getter-local-words',
    source:
      'function frames(error:Error){return new URLSearchParams({get x(){return new Error("fixed")as never;}}).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'spread-setter-replaces-getter',
    source:
      'function frames(error:Error){const setter={set x(_value:never){}};return new URLSearchParams({get x(){return error as never;},...setter}as never).get("x");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('record getter readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'record-getters.ts', source);
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

describe('shared record getter admissions', () => {
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
