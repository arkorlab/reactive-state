import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'late-signal-replacement',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(new Error("fixed"));Object.defineProperty(c,"signal",{value:{reason:error}});return(c.signal.reason as Error).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'first-data-ignores-second-error',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort({message:"fixed"});c.abort(error);return c.signal.reason.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'first-supplied-error',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(error);return(c.signal.reason as Error).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'first-local-words-ignore-second-error',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(new Error("fixed"));c.abort(error);return c.signal.reason.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'later-abort-argument-call',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(new Error("fixed"));c.abort(mutate());return(c.signal.reason as Error).message;function mutate(){Object.defineProperty(c,"signal",{value:{reason:error}});return "ignored";}}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'later-abort-argument-property',
    source:
      'function frames(error:Error){const c=new AbortController();const holder={get reason(){Object.defineProperty(c,"signal",{value:{reason:error}});return "ignored";}};c.abort(new Error("fixed"));c.abort(holder.reason);return(c.signal.reason as Error).message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'known-first-error-survives-later-work',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(error);noop();return c.signal.reason.stack;function noop(){return 1;}}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
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
