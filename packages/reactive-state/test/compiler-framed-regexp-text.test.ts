import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'native-call-pattern',
    source: 'function frames(error:Error){return RegExp(error as never).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-new-pattern',
    source: 'function frames(error:Error){return new RegExp(error as never).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'global-constructor',
    source: 'function frames(error:Error){return new globalThis.RegExp(error as never).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-flags',
    source: 'function frames(error:Error){return RegExp("x",error as never).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-new-flags',
    source: 'function frames(error:Error){return new RegExp("x",error as never).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-call',
    source: 'function frames(error:Error){return RegExp.call(null,error as never).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-apply',
    source: 'function frames(error:Error){return RegExp.apply(null,[error as never]).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflect-apply',
    source: 'function frames(error:Error){return Reflect.apply(RegExp,null,[error]).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'tuple-spread',
    source: 'function frames(error:Error){return RegExp(...[error as never] as [never]).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'array-conversion',
    source: 'function frames(error:Error){return RegExp([error] as never).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'typed-array-conversion',
    source: 'function frames(error:Error){return RegExp([error] as Error[] as never).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'constant-alias',
    source:
      'function frames(error:Error){const Pattern=RegExp;return new Pattern(error as never).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'caught-native-pattern',
    source:
      'function frames(){try{JSON.parse("{");}catch(error){return RegExp(error as never).source;}return "fixed";}',
    refused: true,
    invocation: 'frames()',
  },
  {
    id: 'literal-pattern',
    source: 'function frames(){return RegExp("fixed","i").source;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'empty-constructor',
    source: 'function frames(){return new RegExp().source;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'local-error-words',
    source: 'function frames(){return RegExp(new Error("ours") as never).source;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'local-array-error-words',
    source: 'function frames(){return RegExp([new Error("ours")] as never).source;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'ordinary-data-array',
    source: 'function frames(){return RegExp(["fixed"] as never).source;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'ignored-third-argument',
    source:
      'function frames(error:Error){return (RegExp as (...args:unknown[])=>RegExp)("fixed","",error).source;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-ignored-third',
    source:
      'function frames(error:Error){return (RegExp.call as (...args:unknown[])=>RegExp)(null,"fixed","",error).source;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'apply-ignored-third',
    source:
      'function frames(error:Error){return Reflect.apply(RegExp,null,["fixed","",error]).source;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'receiver-is-ignored',
    source: 'function frames(error:Error){return RegExp.call(error,"fixed").source;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'shadowed-constructor',
    source:
      'function frames(error:Error){const RegExp=(_value:unknown)=>({source:"fixed"});return RegExp(error).source;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'destructured-own-constructor',
    source:
      'function frames(error:Error){const {RegExp:Pattern}={RegExp:(_value:unknown)=>({source:"fixed"})};return Pattern(error).source;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-pattern-copy',
    source: 'function frames(){return new RegExp(/fixed/u).source;}',
    refused: false,
    invocation: 'frames()',
  },
];

describe('regexp error conversion readers', () => {
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

describe('shared regexp error conversions', () => {
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
