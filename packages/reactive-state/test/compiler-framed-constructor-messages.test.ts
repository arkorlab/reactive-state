import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'caught-Error-message',
    source:
      'function frames(){try{JSON.parse("bad");}catch(error){return new Error(error as never).message;}}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'supplied-TypeError-message',
    source: 'function frames(error:Error){return new TypeError(error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'called-Error-message',
    source: 'function frames(error:Error){return Error(error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'AggregateError-message',
    source: 'function frames(error:Error){return new AggregateError([],error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'Error-cause-is-not-message',
    source: 'function frames(error:Error){return new Error("fixed",{cause:error}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-Error-message',
    source: 'function frames(){return new Error(new Error("ours") as never).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'literal-Error-message',
    source: 'function frames(){return new Error("fixed").message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'shadowed-Error-message',
    source:
      'class Error{message="fixed";constructor(_value:unknown){}}function frames(error:unknown){return new Error(error).message;}',
    invocation: 'frames({})',
    refused: false,
  },
  {
    id: 'DOMException-message',
    source: 'function frames(error:Error){return new DOMException(error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'DOMException-name',
    source: 'function frames(error:Error){return new DOMException("fixed",error as never).name;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'AggregateError-errors-not-coerced',
    source: 'function frames(error:Error){return new AggregateError([error],"fixed").message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'Error-empty-spread-message',
    source: 'function frames(error:Error){return new Error(...[] as [],error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'Error-ignored-extra-argument',
    source:
      'function frames(error:Error){return new (Error as new(...args:unknown[])=>Error)("fixed",undefined,error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('constructor-messages readers', () => {
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

describe('shared constructor-messages', () => {
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
