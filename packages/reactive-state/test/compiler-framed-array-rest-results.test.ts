import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    group: 'rest',
    id: 'rest-all-error',
    source: 'function frames(error:Error){const [...values]=[error];return values[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'rest',
    id: 'rest-offset-error',
    source:
      'function frames(error:Error){const [first,...values]=[{stack:"fixed"},error];void first;return values[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'rest',
    id: 'rest-typed-input',
    source: 'function frames(source:Error[]){const [...values]=source;return values[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    group: 'rest',
    id: 'rest-ignored-prefix-error',
    source:
      'function frames(error:Error){const [first,...values]=[error,{stack:"fixed"}];void first;return values[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'rest',
    id: 'rest-ordinary-data',
    source:
      'function frames(error:Error){const [...values]=[{stack:"fixed"}];return values[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'rest',
    id: 'rest-local-words',
    source: 'function frames(){const [...values]=[new Error("fixed")];return values[0]!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    group: 'rest',
    id: 'rest-copy-before-original-write',
    source:
      'function frames(error:Error){const source:any[]=[{stack:"fixed"}];const [...values]=source;source[0]=error;return values[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'rest',
    id: 'rest-lexical-shadow',
    source:
      'function frames(error:Error){const values=[{stack:"fixed"}];{const [...values]=[error];void values;}return values[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native array rest readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-rest.ts', source);
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

describe('native array rest shared', () => {
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
