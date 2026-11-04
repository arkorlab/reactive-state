import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Written source values retain their selected runtime meaning. */
const CASES = [
  {
    id: 'default-toSorted',
    source:
      "function frames(error:Error){return [error,'SyntaxError: fixed'].toSorted()[0]===error;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'default-sort',
    source: "function frames(error:Error){return [error,'SyntaxError: fixed'].sort()[0]===error;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'undefined-comparator',
    source:
      "function frames(error:Error){return [error,'SyntaxError: fixed'].toSorted(undefined)[0]===error;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'alias-default-sort',
    source:
      "function frames(error:Error){const values=[error,'SyntaxError: fixed'];return values.sort()[0]===error;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'borrowed-call-sort',
    source:
      "function frames(error:Error){return Array.prototype.sort.call([error,'SyntaxError: fixed'])[0]===error;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'borrowed-apply-sort',
    source:
      "function frames(error:Error){return Array.prototype.sort.apply([error,'SyntaxError: fixed'],[])[0]===error;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'borrowed-reflect-sort',
    source:
      "function frames(error:Error){return Reflect.apply(Array.prototype.sort,[error,'SyntaxError: fixed'],[])[0]===error;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'provided-comparator',
    source:
      "function frames(error:Error){return [error,'SyntaxError: fixed'].sort(()=>0)[0]===error;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'data-default-sort',
    source: "function frames(error:Error){return ['fixed','data'].toSorted()[0];}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'singleton-default-sort',
    source: 'function frames(error:Error){return [error].sort().length;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'undefined-partner-sort',
    source: 'function frames(error:Error){return [error,undefined].sort().length;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    sharedRefused: true,
  },
  {
    id: 'own-sort-data',
    source:
      "function frames(error:Error){const values=[error,'data'];values.sort=()=>[];return values.sort().length;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'own-toSorted-data',
    source:
      "function frames(error:Error){const values=[error,'data'];values.toSorted=()=>[];return values.toSorted().length;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'constructed-error-words',
    source: "function frames(error:Error){return [new Error('ours'),'data'].toSorted().length;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
    sharedRefused: false,
  },
] as const;

describe('native default array sorting readers', () => {
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

describe('native default array sorting shared modules', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, sharedRefused }) => {
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
    const expected = sharedRefused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
