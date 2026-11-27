import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A read in a `for` initializer or in a `for…of` or `for…in` iterable runs once, before the loop's
 * first pass, so a use of the same binding in the loop's body cannot come before another run of it.
 * A reader that drops its proof when a later use may reach it again keeps the proof for such a read.
 */
const CASES = [
  {
    id: 'for-initializer-read-body-use',
    source:
      'function frames(error:Error){let result;for(let i=(result=Object.getPrototypeOf(Object.create(error)).stack,0);i<2;i++){void error;}return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'for-initializer-read-body-and-later-use',
    source:
      'function frames(error:Error){let result;for(let i=(result=Object.getPrototypeOf(Object.create(error)).stack,0);i<2;i++){void error;}void error;return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'for-of-iterable-read-body-use',
    source:
      'function frames(error:Error){let result;for(const each of [(result=Object.getPrototypeOf(Object.create(error)).stack,1),2]){void each;void error;}return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'for-in-iterable-read-body-use',
    source:
      'function frames(error:Error){let result;for(const each in ((result=Object.getPrototypeOf(Object.create(error)).stack),{a:1,b:2})){void each;void error;}return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'for-initializer-read-no-body-use',
    source:
      'function frames(error:Error){let result;for(let i=(result=Object.getPrototypeOf(Object.create(error)).stack,0);i<2;i++){}return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'read-before-later-use-no-loop',
    source:
      'function frames(error:Error){const result=Object.getPrototypeOf(Object.create(error)).stack;void error;return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'for-initializer-read-local-prototype-data',
    source:
      'function frames(error:Error){let result;for(let i=(result=Object.getPrototypeOf(Object.create({stack:"fixed"})).stack,0);i<2;i++){void error;}return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('reads that run once before a loop', () => {
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
    using parsed = parseModule(api, 'loop-once-read.ts', source);
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
