import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    group: 'mutator',
    id: 'push-borrowed-call',
    source:
      'function frames(error:Error){const values:unknown[]=[];Array.prototype.push.call(values,error);return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'mutator',
    id: 'unshift-borrowed-apply',
    source:
      'function frames(error:Error){const values:unknown[]=[];Array.prototype.unshift.apply(values,[error]);return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'mutator',
    id: 'push-reflect-apply',
    source:
      'function frames(error:Error){const values:unknown[]=[];Reflect.apply(Array.prototype.push,values,[error]);return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'mutator',
    id: 'push-bound-native',
    source:
      'function frames(error:Error){const values:unknown[]=[];const append=Array.prototype.push.bind(values);append(error);return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'mutator',
    id: 'splice-borrowed-call',
    source:
      'function frames(error:Error){const values:unknown[]=[];Array.prototype.splice.call(values,0,0,error);return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'mutator',
    id: 'fill-borrowed-call',
    source:
      'function frames(error:Error){const values:unknown[]=[0];Array.prototype.fill.call(values,error);return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'mutator',
    id: 'borrowed-ignores-own-push',
    source:
      'function frames(error:Error){const values:unknown[]=[];values.push=()=>0;Array.prototype.push.call(values,error);return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'mutator',
    id: 'borrowed-push-data',
    source:
      'function frames(error:Error){const values:unknown[]=[];Array.prototype.push.call(values,"fixed");return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'mutator',
    id: 'borrowed-push-after-read',
    source:
      'function frames(error:Error){const values:unknown[]=[];const answer=values.join();Array.prototype.push.call(values,error);return answer;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'mutator',
    id: 'shadow-array-call-data',
    source:
      'const Array={prototype:{push:{call:(_values:unknown[],_error:Error)=>0}}};function frames(error:Error){const values:unknown[]=[];Array.prototype.push.call(values,error);return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native array mutator readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-mutator.ts', source);
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

describe('native array mutator shared', () => {
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
