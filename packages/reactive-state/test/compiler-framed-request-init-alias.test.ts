import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'const-init-error',
    source:
      'async function frames(error:Error){const init={method:"POST",body:error as never};return await new Request("https://example.test/",init).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'const-init-chain-error',
    source:
      'async function frames(error:Error){const init={method:"POST",body:error as never};const other=init;return await new Request("https://example.test/",other).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'const-init-data',
    source:
      'async function frames(error:Error){const init={method:"POST",body:"fixed"};return await new Request("https://example.test/",init).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'const-init-prior-write-data',
    source:
      'async function frames(error:Error){const init={method:"POST",body:error as never};init.body="fixed" as never;return await new Request("https://example.test/",init).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'const-init-exposed-alias-data',
    source:
      'async function frames(error:Error){const init={method:"POST",body:error as never};const other=init;other.body="fixed" as never;return await new Request("https://example.test/",init).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('constant Request init alias readers', () => {
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

describe('constant Request init alias admissions', () => {
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
