import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'reflected-subclass-stack',
    source:
      'class Failure extends Error{}function frames(){return Reflect.construct(Failure,[]).stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'reflected-subclass-alias-stack',
    source:
      'class Failure extends Error{}const Alias=Failure;function frames(){return Reflect.construct(Alias,[]).stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'reflected-subclass-data-field',
    source:
      'class Failure extends Error{stack="fixed";}function frames(){return Reflect.construct(Failure,[]).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'reflected-subclass-data-write',
    source:
      'class Failure extends Error{constructor(){super();this.stack="fixed";}}function frames(){return Reflect.construct(Failure,[]).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'reflected-returned-data',
    source:
      'class Failure extends Error{constructor(){super();return {stack:"fixed"} as Error;}}function frames(){return Reflect.construct(Failure,[]).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'reflected-returned-supplied-message',
    source:
      'class Failure extends Error{constructor(error:Error){super();return error;}}function frames(error:Error){return Reflect.construct(Failure,[error]).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reflected-local-words',
    source:
      'class Failure extends Error{}function frames(){return Reflect.construct(Failure,[]).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'reflected-ordinary-class',
    source:
      'class Failure{stack="fixed";}function frames(){return Reflect.construct(Failure,[]).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'shadowed-Reflect-construct',
    source:
      'const Reflect={construct(_target:unknown,_args:unknown[]){return {stack:"fixed"};}};class Failure extends Error{}function frames(){return Reflect.construct(Failure,[]).stack;}',
    invocation: 'frames()',
    refused: false,
  },
];

describe('reflected-subclasses readers', () => {
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

describe('shared reflected-subclasses', () => {
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
