import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'constructor-literal-stack',
    source:
      'class Failure extends Error{constructor(){super();this.stack="fixed";}}function frames(){return new Failure().stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'constructor-element-stack',
    source:
      'class Failure extends Error{constructor(){super();this["stack"]="fixed";}}function frames(){return new Failure().stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'constructor-inherited-literal-stack',
    source:
      'class Base extends Error{constructor(){super();this.stack="fixed";}}class Failure extends Base{}function frames(){return new Failure().stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'conditional-stack-remains-private',
    source:
      'class Failure extends Error{constructor(flag:boolean){super();if(flag)this.stack="fixed";}}function frames(){return new Failure(false).stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'native-stack-remains-private',
    source: 'class Failure extends Error{}function frames(){return new Failure().stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'ordinary-class-stack-data',
    source: 'class Failure{stack="fixed";}function frames(){return new Failure().stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'opaque-super-message-stays-private',
    source:
      'class Failure extends Error{constructor(error:Error){super(error as never);this.stack="fixed";}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('constructor-stack-writes readers', () => {
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

describe('shared constructor-stack-writes', () => {
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
