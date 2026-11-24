import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'well-known-symbol-key',
    source: 'function frames(error:Error){return error[Symbol.toStringTag as never];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'created-symbol-key',
    source: 'function frames(error:Error){return error[Symbol("tag") as never];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'constant-symbol-key',
    source:
      'const key=Symbol.toStringTag;function frames(error:Error){return error[key as never];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reflect-symbol-key',
    source: 'function frames(error:Error){return Reflect.get(error,Symbol.toStringTag);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'ordinary-string-frame-key',
    source: 'function frames(error:Error){return error["stack"];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'shadowed-Symbol-key',
    source:
      'const Symbol={toStringTag:"stack"};function frames(error:Error){return error[Symbol.toStringTag as never];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('symbol-keys readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'recursive-error-members.ts', source);
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

describe('shared symbol-keys', () => {
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
