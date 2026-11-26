import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'mapped-canonical-error',
    source:
      'type Copy<T>={[K in keyof T]:T[K]};type Failure=Copy<{failure:Error}>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'mapped-canonical-data',
    source:
      'type Copy<T>={[K in keyof T]:T[K]};type Failure=Copy<{failure:{stack:string}}>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'mapped-generic-key-error',
    source:
      'type Copy<T>={[K in keyof T]:T[K]};type Select<T,K extends keyof T>=Copy<T>[K];type Failure=Select<{failure:Error;ok:{stack:string}},"failure">;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'mapped-generic-key-data',
    source:
      'type Copy<T>={[K in keyof T]:T[K]};type Select<T,K extends keyof T>=Copy<T>[K];type Failure=Select<{failure:Error;ok:{stack:string}},"ok">;function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'mapped-readonly-optional-error',
    source:
      'type Copy<T>={readonly [K in keyof T]?:T[K]};type Failure=Copy<{failure:Error}>["failure"];function frames(error:Failure){return error?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'mapped-nested-member-error',
    source:
      'type Copy<T>={[K in keyof T]:T[K]};type Failure=Copy<{box:{failure:Error}}>["box"]["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'mapped-distinct-alias-error',
    source:
      'type Container<T>={failure:T};type Copy<T>={[K in keyof T]:T[K]};type Failure=Copy<Container<Error>>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'mapped-distinct-alias-data',
    source:
      'type Container<T>={failure:T};type Copy<T>={[K in keyof T]:T[K]};type Failure=Copy<Container<{stack:string}>>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'mapped-key-remap-data',
    source: `type Copy<T>={[K in keyof T as \`copy_\${K&string}\`]:T[K]};type Failure=Copy<{failure:{stack:string}}>["copy_failure"];function frames(error:Failure){return error.stack;}`,
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'mapped-finite-recursive-data',
    source:
      'type Link={failure:{stack:string};next:Link};type Copy<T>={[K in keyof T]:T[K]};type Failure=Copy<Link>["next"]["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
  {
    id: 'mapped-key-parameter-shadow-error',
    source:
      'type K="other";type Copy<T>={[K in keyof T]:T[K]};type Failure=Copy<{failure:Error}>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'mapped-unrelated-copy-name-data',
    source:
      'type Copy<T>={failure:{stack:string};ignored?:T};type Failure=Copy<Error>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    reader: false,
    refused: false,
  },
];

describe('homomorphic mapped selections readers', () => {
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

describe('homomorphic mapped selections admissions', () => {
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
    await recordReasons(source, reasons);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});

/** Focused comparison diagnostics retain the actual compiler refusal without changing expectations. */
async function recordReasons(source: string, reasons: readonly string[]): Promise<void> {
  const path = process.env['MAPPED_TYPE_OBSERVATIONS'];
  if (path === undefined || path === '') return;
  const { appendFileSync } = await import('node:fs');
  appendFileSync(path, `${JSON.stringify({ source, reasons })}\n`);
}
