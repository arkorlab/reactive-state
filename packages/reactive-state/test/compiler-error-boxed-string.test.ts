import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native boxed strings convert supplied error words at construction. */
const CASES = [
  {
    id: 'caught-box-value-of',
    source:
      'function frames(){try{JSON.parse("{");return "";}catch(error){return new String(error as never).valueOf();}}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'caught-box-to-string',
    source:
      'function frames(){try{JSON.parse("{");return "";}catch(error){return new String(error as never).toString();}}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'caught-global-box-value-of',
    source:
      'function frames(){try{JSON.parse("{");return "";}catch(error){return new globalThis.String(error as never).valueOf();}}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'supplied-box-value-of',
    source: 'function frames(error:Error){return new String(error as never).valueOf();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'supplied-global-box-to-string',
    source:
      'function frames(error:Error){return new globalThis.String(error as never).toString();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'existing-string-call',
    source: 'function frames(error:Error){return String(error);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'written-error-box-value-of',
    source: 'function frames(){return new String(new Error("ours") as never).valueOf();}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'written-error-box-to-string',
    source: 'function frames(){return new String(new Error("ours") as never).toString();}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'ordinary-string-data',
    source: 'function frames(){return new String("fixed").valueOf();}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'omitted-constructor-arguments',
    source: 'function frames(){return (new String).valueOf();}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'local-string-constructor',
    source:
      'function frames(error:Error){class String{constructor(_value:unknown){}valueOf(){return "fixed";}}return new String(error).valueOf();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-globalthis-constructor',
    source:
      'function frames(error:Error){const globalThis={String:class{constructor(_value:unknown){}toString(){return "fixed";}}};return new globalThis.String(error).toString();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('boxed string error readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'boxed-string.ts', source);
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

describe('shared boxed string error results', () => {
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
    const sharedReason = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [sharedReason] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
