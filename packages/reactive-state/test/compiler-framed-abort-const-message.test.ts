import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

const CASES = [
  {
    id: 'const-message',
    source:
      'function frames(error:Error){const message="fixed";const c=new AbortController();c.abort(new Error(message));return(c.signal.reason as Error).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'literal-message',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(new Error("fixed"));return(c.signal.reason as Error).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'coercing-message',
    source:
      'function frames(error:Error){const c=new AbortController();const message={toString(){c.abort(error);return "fixed";}};c.abort(new Error(message as never));return(c.signal.reason as Error).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'destructured-default-coercion',
    source:
      'function frames(error:Error){const c=new AbortController();const{missing:message={toString:mutate}}="fixed" as unknown as {missing?:{toString():string}};c.abort(new Error(message as never));return(c.signal.reason as Error).message;function mutate(){c.abort(error);return"fixed";}}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'destructured-default-data',
    source:
      'function frames(error:Error){const c=new AbortController();const{missing:message="fixed"}="" as unknown as {missing?:string};c.abort(new Error(message));return c.signal.reason.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('native finally fulfillment readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-observations.ts', source);
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

describe('native finally fulfillment admissions', () => {
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
