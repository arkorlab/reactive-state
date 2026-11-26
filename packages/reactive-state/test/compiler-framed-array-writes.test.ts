import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Written source values retain their selected runtime meaning. */
const CASES = [
  {
    id: 'push-error',
    source:
      "function frames(error:Error){const values:unknown[]=[];values.push(error);return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'index-error',
    source:
      "function frames(error:Error){const values:unknown[]=[];values[0]=error;return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unshift-error',
    source:
      "function frames(error:Error){const values:unknown[]=[];values.unshift(error);return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'splice-error',
    source:
      "function frames(error:Error){const values:unknown[]=[];values.splice(0,0,error);return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'fill-error',
    source:
      "function frames(error:Error){const values:unknown[]=[0];values.fill(error);return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias-push-error',
    source:
      "function frames(error:Error){const values:unknown[]=[];const alias=values;alias.push(error);return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-push-error',
    source:
      "function frames(error:Error){const values:unknown[]=[];values.push(...[error]);return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'toString-error',
    source:
      'function frames(error:Error){const values:unknown[]=[];values.push(error);return values.toString();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'deferred-before-error',
    source:
      "function frames(error:Error){const values:unknown[]=[];function text(){return values.join(',');}values.push(error);return text();}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'push-data',
    source:
      "function frames(error:Error){const values:unknown[]=[];values.push('fixed');return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'write-after-read',
    source:
      "function frames(error:Error){const values:unknown[]=[];const text=values.join(',');values.push(error);return text;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unselected-write',
    source:
      "function frames(error:Error){const values:unknown[]=[];if(false)values.push(error);return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'other-binding-write',
    source:
      "function frames(error:Error){const values:unknown[]=[];const other:unknown[]=[];other.push(error);return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'shadowed-inner-write',
    source:
      "function frames(error:Error){const values:unknown[]=[];function ignored(){const values:unknown[]=[];values.push(error);}return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-join-data',
    source:
      "function frames(error:Error){const values:unknown[]=[];values.join=()=> 'fixed';values.push(error);return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-error-words',
    source:
      "function frames(error:Error){const values:unknown[]=[];values.push(new Error('ours'));return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unchanged-literal-error',
    source: "function frames(error:Error){const values=[error];return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'heritage-push-error',
    source:
      "function frames(error:Error){const values:unknown[]=[];class Base{}class Holder extends (values.push(error),Base){}void Holder;return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'heritage-other-push',
    source:
      "function frames(error:Error){const values:unknown[]=['fixed'];const other:unknown[]=[];class Base{}class Holder extends (other.push(error),Base){}void Holder;return values.join(',');}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
] as const;

describe('array element writes readers', () => {
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

describe('array element writes shared modules', () => {
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
