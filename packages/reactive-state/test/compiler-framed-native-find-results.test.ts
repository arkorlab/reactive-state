import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Written source values retain their selected runtime meaning. */
const CASES = [
  {
    id: 'find-frames',
    source: 'function frames(error:Error){return [error].find(()=>true)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'findLast-frames',
    source: 'function frames(error:Error){return [error].findLast(()=>true)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'find-alias-frames',
    source:
      'function frames(error:Error){const values=[error];return values.find(()=>true)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'find-supplied-words',
    source: 'function frames(error:Error){return [error].find(()=>true)!.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'find-own-words',
    source: "function frames(error:Error){return [new Error('ours')].find(()=>true)!.message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'find-data',
    source: "function frames(error:Error){return [{stack:'fixed'}].find(()=>true)!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'findLast-data',
    source: "function frames(error:Error){return [{stack:'fixed'}].findLast(()=>true)!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'find-false-predicate',
    source: 'function frames(error:Error){return [error].find(()=>false);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'findIndex-is-number',
    source: 'function frames(error:Error){return [error].findIndex(()=>true);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'findLastIndex-is-number',
    source: 'function frames(error:Error){return [error].findLastIndex(()=>true);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'some-is-boolean',
    source: 'function frames(error:Error){return [error].some(()=>true);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'every-is-boolean',
    source: 'function frames(error:Error){return [error].every(()=>true);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-find-data',
    source:
      "function frames(error:Error){const values=[error];values.find=()=>({stack:'fixed'}) as Error;return values.find(()=>true)!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'typed-find-frames',
    source:
      'function frames(error:Error){const values:Error[]=[error];return values.find(()=>true)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
] as const;

describe('native array find results readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-write-error.ts', source);
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

describe('native array find results shared modules', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
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
