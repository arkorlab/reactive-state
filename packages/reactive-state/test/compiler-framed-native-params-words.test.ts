import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'params-overwritten-record-field',
    source:
      'function frames(error:Error){return new URLSearchParams({...{x:error as never},x:"fixed"}).get("x")??"";}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },

  {
    id: 'params-entry-value',
    source:
      'function frames(error:Error){return new URLSearchParams([["x",error as never]]).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-entry-key',
    source:
      'function frames(error:Error){return new URLSearchParams([[error as never,"fixed"]]).toString();}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-record-value',
    source:
      'function frames(error:Error){return new URLSearchParams({x:error as never}).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-entry-array-alias',
    source:
      'function frames(error:Error){const entries:[[string,Error]]=[["x",error]];return new URLSearchParams(entries as never).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-constructor-alias',
    source:
      'const Params=URLSearchParams;function frames(error:Error){return new Params([["x",error as never]]).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
  },
  {
    id: 'params-typed-entry-values',
    source:
      'function frames(entries:[string,Error][]){return new URLSearchParams(entries as never).toString();}',
    invocation: 'frames([["x",new Error("supplied")]])',
    refused: true,
  },
  {
    id: 'params-ordinary-values',
    source: 'function frames(){return new URLSearchParams([["x","fixed"]]).get("x");}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'params-local-shadow',
    source:
      'function frames(error:Error){class URLSearchParams{constructor(_value:unknown){}get(_key:string){return"fixed";}}return new URLSearchParams([["x",error]]).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-ignored-extra-argument',
    source:
      'function frames(error:Error){return Reflect.construct(URLSearchParams,[[["x","fixed"]],error]).get("x");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
  },
  {
    id: 'params-local-error',
    source:
      'function frames(){return new URLSearchParams([["x",new Error("fixed")as never]]).get("x");}',
    invocation: 'frames()',
    refused: false,
  },
];

describe('native params word readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-params-words.ts', source);
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

describe('shared native params words', () => {
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
