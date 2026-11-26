import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Parameter defaults retain caller key alternatives without widening known local values. */
const CASES = [
  {
    id: 'parameter-default-stack-alternative',
    source: 'function frames(key:"message"|"stack"="message"){return new Error("ours")[key]??"";}',
    invocation: 'frames("stack")',
    refused: true,
  },
  {
    id: 'parameter-default-reflect-stack',
    source:
      'function frames(key:"message"|"stack"="message"){return Reflect.get(new Error("ours"),key);}',
    invocation: 'frames("stack")',
    refused: true,
  },
  {
    id: 'parameter-default-computed-binding',
    source:
      'function frames(key:"message"|"stack"="message"){const {[key]:result}=new Error("ours");return result;}',
    invocation: 'frames("stack")',
    refused: true,
  },
  {
    id: 'parameter-safe-only-union',
    source: 'function frames(key:"message"|"name"="message"){return new Error("ours")[key];}',
    invocation: 'frames("name")',
    refused: false,
  },
  {
    id: 'parameter-ordinary-data',
    source:
      'function frames(key:"message"|"stack"="message"){return {message:"fixed",stack:"fixed"}[key];}',
    invocation: 'frames("stack")',
    refused: false,
  },
  {
    id: 'const-known-safe-precedence',
    source:
      'function frames(){const key:"message"|"stack"="message";return new Error("ours")[key];}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'const-written-stack-precedence',
    source:
      'function frames(){const key:"message"="stack" as "message";return new Error("ours")[key];}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'var-known-safe-initializer',
    source: 'function frames(){let key:"message"|"stack"="message";return new Error("ours")[key];}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'var-written-stack-initializer',
    source:
      'function frames(){let key:"message"="stack" as "message";return new Error("ours")[key];}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'parameter-written-stack-assignment',
    source:
      'function frames(key:"message"="message"){key="stack" as "message";return new Error("ours")[key];}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'parameter-no-default-retains-union',
    source: 'function frames(key:"message"|"stack"){return new Error("ours")[key];}',
    invocation: 'frames("stack")',
    refused: true,
  },
  {
    id: 'parameter-literal-safe-default',
    source: 'function frames(key:"message"="message"){return new Error("ours")[key];}',
    invocation: 'frames()',
    refused: false,
  },
];

describe('default parameter key readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'parameter-default-keys.ts', source);
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

describe('shared default parameter key results', () => {
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
    const sharedReason = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [sharedReason] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
