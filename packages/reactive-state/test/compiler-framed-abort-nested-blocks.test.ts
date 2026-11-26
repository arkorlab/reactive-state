import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native abort reasons retain their original Error identity across ordinary lexical blocks. */
const CASES = [
  {
    id: 'nested-prior-error',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(error);{return c.signal.reason.stack;}}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-prior-error-keeps-words',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(error);{c.abort(new Error("fixed"));return(c.signal.reason as Error).message;}}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-two-blocks',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(error);{{return c.signal.reason.stack;}}}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-prior-default',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort();{return c.signal.reason.stack;}}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-written-words-pin',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(new Error("fixed"));{return c.signal.reason.message;}}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-first-data-pin',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort({stack:"fixed"});{c.abort(error);return c.signal.reason.stack;}}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-controller-shadow-pin',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(error);{const c=new AbortController();c.abort({stack:"fixed"});return c.signal.reason.stack;}}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-prior-written-stack-pin',
    source:
      'function frames(error:Error){const reason=Object.defineProperty(new Error("fixed"),"stack",{value:"fixed"});const c=new AbortController();c.abort(reason);{return c.signal.reason.stack;}}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-outer-written-stack-pin',
    source:
      'function frames(error:Error){const reason=Object.defineProperty(new Error("fixed"),"stack",{value:"fixed"});{const c=new AbortController();c.abort(reason);{return c.signal.reason.stack;}}}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-existing-immediate-error-pin',
    source:
      'function frames(error:Error){JSON.parse("{}");{const c=new AbortController();c.abort(error);return c.signal.reason.stack;}}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('nested and static abort reason readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'abort-reason-observations.ts', source);
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

describe('nested and static abort reason admissions', () => {
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
