import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'prototype-supplied-stack',
    source: 'function frames(error:Error){return Object.create(error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'prototype-made-stack',
    source: 'function frames(){return Object.create(new Error("ours")).stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'prototype-supplied-message',
    source: 'function frames(error:Error){return Object.create(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'prototype-made-message',
    source: 'function frames(){return Object.create(new Error("ours")).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'prototype-own-stack-data',
    source:
      'function frames(error:Error){return Object.create(error,{stack:{value:"fixed"}}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'prototype-null-data',
    source: 'function frames(){return Object.create(null,{stack:{value:"fixed"}}).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'prototype-ordinary-data',
    source: 'function frames(){return Object.create({stack:"fixed"}).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'prototype-own-message-data',
    source:
      'function frames(error:Error){return Object.create(error,{message:{value:"fixed"}}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'shadowed-Object-create',
    source:
      'const Object={create(_value:unknown){return {stack:"fixed"};}};function frames(error:Error){return Object.create(error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('created-prototypes readers', () => {
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

describe('shared created-prototypes', () => {
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
