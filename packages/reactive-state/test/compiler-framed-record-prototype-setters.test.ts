import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A record's `__proto__:` entry sets its prototype and gives the native conversions no own entry. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-proto-setter',
    source:
      'function caption(error:Error){return new URLSearchParams({__proto__:error}as never).toString();}',
    invocation: 'caption(new Error("ours"))',
    refused: false,
  },
  {
    id: 'string-proto-setter',
    source:
      'function caption(error:Error){return new URLSearchParams({"__proto__":error}as never).toString();}',
    invocation: 'caption(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-proto-setter',
    source:
      'function caption(error:Error){return String(new Headers({__proto__:error}as never).get("__proto__"));}',
    invocation: 'caption(new Error("ours"))',
    refused: false,
  },
  {
    id: 'spread-proto-setter',
    source:
      'function caption(error:Error){return new URLSearchParams({...{__proto__:error}}as never).toString();}',
    invocation: 'caption(new Error("ours"))',
    refused: false,
  },
  {
    id: 'saved-proto-setter',
    source:
      'function caption(error:Error){const record={__proto__:error};return new URLSearchParams(record as never).toString();}',
    invocation: 'caption(new Error("ours"))',
    refused: false,
  },
  {
    id: 'computed-proto-entry',
    source:
      'function caption(error:Error){return new URLSearchParams({["__proto__"]:error}as never).toString();}',
    invocation: 'caption(new Error("ours"))',
    refused: true,
  },
  {
    id: 'shorthand-proto-entry',
    source:
      'function caption(error:Error){const __proto__=error;return new URLSearchParams({__proto__}as never).toString();}',
    invocation: 'caption(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entry-beside-proto-setter',
    source:
      'function caption(error:Error){return new URLSearchParams({__proto__:{},x:error}as never).toString();}',
    invocation: 'caption(new Error("ours"))',
    refused: true,
  },
];

describe('record prototype setter readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'record-prototype-setters.ts', source);
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

describe('shared record prototype setter admissions', () => {
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
