import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A known own encoder method does not convert arguments by native Web IDL rules. */
const CASES = [
  {
    id: 'direct-member-stack',
    source: 'function frames(error:Error){return ({failure:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'bracket-member-message',
    source: 'function frames(error:Error){return ({failure:error})["failure"].message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'shorthand-member-stack',
    source: 'function frames(error:Error){return ({error}).error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'computed-constant-member',
    source:
      'function frames(error:Error){const key="failure";return ({[key]:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-literal-member',
    source: 'function frames(error:Error){return ({outer:{failure:error}}).outer.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'later-literal-spread-error',
    source:
      'function frames(error:Error){return ({failure:{stack:"fixed"},...{failure:error}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-computed-member',
    source:
      'function frames(error:Error,key:string="failure"){return ({[key]:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'opaque-spread-keeps-possible-error',
    source:
      'function frames(error:Error,extra:Record<string,unknown>={}){return ({failure:error,...extra}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'selected-plain-data',
    source:
      'function frames(error:Error){return ({failure:{stack:"fixed"},other:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'later-property-overwrites-error',
    source:
      'function frames(error:Error){return ({failure:error,failure:{stack:"fixed"}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'later-spread-overwrites-error',
    source:
      'function frames(error:Error){return ({failure:error,...{failure:{stack:"fixed"}}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unselected-error-member',
    source:
      'function frames(error:Error){return ({failure:{message:"fixed"},other:error}).failure.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'member-local-made-words',
    source: 'function frames(){return ({failure:new Error("ours")}).failure.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'local-error-class-data',
    source:
      'class Error{stack="fixed";}function frames(){return ({failure:new Error()}).failure.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'nonmatching-computed-key-data',
    source:
      'function frames(error:Error){const key="other";return ({failure:{stack:"fixed"},[key]:error}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'known-property-after-opaque-spread',
    source:
      'function frames(error:Error,extra:Record<string,unknown>={}){return ({...extra,failure:{stack:"fixed"}}).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('literal object member readers', () => {
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

describe('shared literal object members', () => {
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
