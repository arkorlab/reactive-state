import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'first-abort-ignored-tail-application',
    source:
      'function frames(error:Error){const controller=new AbortController();(controller.abort as(...args:unknown[])=>void)(new Error("fixed"),mutate());return(controller.signal.reason as Error).message;function mutate(){controller.abort(error);}}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'first-abort-direct-data',
    source:
      'function frames(error:Error){const controller=new AbortController();controller.abort({message:"fixed"});return controller.signal.reason.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'first-abort-direct-supplied-error',
    source:
      'function frames(error:Error){const controller=new AbortController();controller.abort(error);return(controller.signal.reason as Error).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'first-reason-nested-operand-application',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(new Error(mutate()));return(c.signal.reason as Error).message;function mutate(){c.abort(error);return "fixed";}}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'first-native-literal-asserted-local-words',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(new Error("fixed"));return(c.signal.reason as Error).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'first-native-options-data-asserted-local-words',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(new Error("fixed",{cause:error}));return(c.signal.reason as Error).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('later abort signal exposure readers', () => {
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

describe('later abort signal exposure admissions', () => {
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
