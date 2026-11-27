import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A bound native Error whose message words are all written locally is no Error whose words were
 * supplied, so a read of it is data. That exemption is a proof that a write in a loop's condition or
 * update must drop, as a write before the call does: the next pass reads what the condition wrote.
 */
const CASES = [
  {
    id: 'tuple-written-in-loop-condition',
    source:
      'function frames(error:Error){const args:[null,string]=[null,"fixed"];let out="";let i=0;do{out=(Error.bind(...args)() as Error).message;}while((args[1]=error as never,i++<1));return out;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'tuple-written-in-loop-update',
    source:
      'function frames(error:Error){const args:[null,string]=[null,"fixed"];let out="";for(let i=0;i<2;args[1]=error as never,i++){out=(Error.bind(...args)() as Error).message;}return out;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'tuple-written-in-loop-body',
    source:
      'function frames(error:Error){const args:[null,string]=[null,"fixed"];let out="";for(let i=0;i<2;i++){out=(Error.bind(...args)() as Error).message;args[1]=error as never;}return out;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'tuple-written-before-call',
    source:
      'function frames(error:Error){const args:[null,string]=[null,"fixed"];args[1]=error as never;return (Error.bind(...args)() as Error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'tuple-untouched-by-loop-condition-data',
    source:
      'function frames(error:Error){const args:[null,string]=[null,"fixed"];let out="";let i=0;do{out=(Error.bind(...args)() as Error).message;}while(i++<1);return out;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'tuple-unchanged-data',
    source:
      'function frames(error:Error){const args:[null,string]=[null,"fixed"];return (Error.bind(...args)() as Error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'literal-arguments-data',
    source:
      'function frames(error:Error){let out="";let i=0;do{out=(Error.bind(null,"fixed")() as Error).message;}while(i++<1);return out;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('bound native Error locality under a loop condition', () => {
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

  it.each(CASES)('reads $id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'bound-loop-locality.ts', source);
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
