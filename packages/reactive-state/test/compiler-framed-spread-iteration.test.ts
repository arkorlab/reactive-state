import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
const CASES = [
  {
    group: 'spread',
    id: 'forof-spread-error',
    source:
      'function frames(error:Error){let value:{stack?:string}={stack:"fixed"};for(value of [...[{stack:"data"},error]]){}return value.stack??"";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'spread',
    id: 'forof-spread-data',
    source:
      'function frames(error:Error){let value:{stack?:string}={stack:"fixed"};for(value of [...[{stack:"data"},{stack:"fixed"}]]){}return value.stack??"";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'spread',
    id: 'forof-spread-unselected',
    source:
      'function frames(error:Error){let value:{stack?:string}={stack:"fixed"};if(false){for(value of [...[{stack:"data"},error]])return value.stack??"";}return value.stack??"";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
] as const;

describe('spread readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'source-writes.ts', source);
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

describe('spread shared modules', () => {
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
    const refusal = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [refusal] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
