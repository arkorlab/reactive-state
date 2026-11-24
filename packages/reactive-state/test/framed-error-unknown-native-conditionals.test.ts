import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Unknown is not a native Error; unsupported structural relations stay opaque. */
const CASES = [
  {
    name: 'unknown compared to native Error',
    declaration: 'type Failure = unknown extends Error ? Error : { stack: string };',
    error: false,
  },
  {
    name: 'unknown compared to native TypeError',
    declaration: 'type Failure = unknown extends TypeError ? Error : { stack: string };',
    error: false,
  },
  {
    name: 'unknown through an actual argument',
    declaration:
      'type Select<T> = T extends Error ? Error : { stack: string }; type Failure = Select<unknown>;',
    error: false,
  },
  {
    name: 'unknown through a default argument',
    declaration:
      'type Select<T = unknown> = T extends Error ? Error : { stack: string }; type Failure = Select;',
    error: false,
  },
  {
    name: 'unknown compared to qualified Error',
    declaration: 'type Failure = unknown extends globalThis.Error ? Error : { stack: string };',
    error: false,
  },
  {
    name: 'unknown structural relation stays opaque',
    declaration: 'type Failure = unknown extends { stack: string } ? Error : { stack: string };',
    error: true,
  },
  {
    name: 'unknown local Error relation stays opaque',
    declaration:
      'class Error { stack = "data"; } type Failure = unknown extends Error ? globalThis.Error : { stack: string };',
    error: true,
  },
  {
    name: 'unresolved generic relation stays opaque',
    declaration: 'type Failure<T> = T extends Error ? Error : { stack: string };',
    generic: true,
    error: true,
  },
  {
    name: 'any Error relation stays opaque',
    declaration: 'type Failure = any extends Error ? Error : { stack: string };',
    error: true,
  },
  {
    name: 'native Error relation retains selected branch',
    declaration: 'type Failure = TypeError extends Error ? Error : { stack: string };',
    error: true,
  },
] as const;

describe('unknown native error conditional reader', () => {
  it.each(CASES)('$name', (row) => {
    const { declaration, error } = row;
    const parameters = 'generic' in row ? '<T>' : '';
    const annotation = 'generic' in row ? 'Failure<T>' : 'Failure';
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'unknown-error.ts',
      `${declaration} function frames${parameters}(error: ${annotation}) { return error.stack; }`,
    );
    const pending: Node[] = [parsed.sourceFile];
    const reasons: string[] = [];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      const reason = framedRead(node);
      if (reason !== undefined) reasons.push(reason);
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(reasons.length > 0).toBe(error);
  });
});

describe('unknown native error conditional shared admission', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$name', async (row) => {
    const { declaration, error } = row;
    const parameters = 'generic' in row ? '<T>' : '';
    const annotation = 'generic' in row ? 'Failure<T>' : 'Failure';
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        declaration,
        `function frames${parameters}(error: ${annotation}): string { return error.stack ?? ""; }`,
        "export function normalizeFilter(value:string):TodoFilter{return frames({stack:value}).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = error ? [shared] : [];

    expect(compile(app).refusals.map((item) => item.reason)).toStrictEqual(expected);
  });
});
