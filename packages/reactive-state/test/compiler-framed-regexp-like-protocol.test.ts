import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'reported-regexp-like-source',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:true,source:error,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-regexp-like-source',
    source:
      'function frames(error:Error){return RegExp({[Symbol.match]:true,source:error,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'global-regexp-like-source',
    source:
      'function frames(error:Error){return new globalThis.RegExp({[Symbol.match]:true,source:error,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias-regexp-like-source',
    source:
      'function frames(error:Error){const Pattern=RegExp;return new Pattern({[Symbol.match]:true,source:error,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-pattern-alias',
    source:
      'function frames(error:Error){const pattern={[Symbol.match]:true,source:error,flags:""};return new RegExp(pattern as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'chained-pattern-alias',
    source:
      'function frames(error:Error){const first={[Symbol.match]:true,source:error,flags:""};const pattern=first;return new RegExp(pattern as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'error-binding-alias',
    source:
      'function frames(error:Error){const alias=error;return new RegExp({[Symbol.match]:true,source:alias,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'computed-data-source',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:true,["source"]:error,["flags"]:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'truthy-match-number',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:1,source:error,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'truthy-match-text',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:"yes",source:error,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'explicit-flags-source',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:true,source:error,flags:""} as never,"i").source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-flags-source',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:true,source:error,flags:""} as never,undefined).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-call-source',
    source:
      'function frames(error:Error){return RegExp.call(null,{[Symbol.match]:true,source:error,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-apply-source',
    source:
      'function frames(error:Error){return RegExp.apply(null,[{[Symbol.match]:true,source:error,flags:""} as never]).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reflect-apply-source',
    source:
      'function frames(error:Error){return Reflect.apply(RegExp,null,[{[Symbol.match]:true,source:error,flags:""}]).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'literal-tuple-source',
    source:
      'function frames(error:Error){return new RegExp(...[{[Symbol.match]:true,source:error,flags:""} as never]as[never]).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'constructed-own-constructor',
    source:
      'function frames(error:Error){return new RegExp({constructor:RegExp,[Symbol.match]:true,source:error,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-defined-flags-avoids-early-return',
    source:
      'function frames(error:Error){return RegExp({constructor:RegExp,[Symbol.match]:true,source:error,flags:""} as never,"i").source;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'regexp-like-flags',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:true,source:"fixed",flags:error} as never).flags;}',
    invocation: 'frames(Object.assign(new Error("i"),{name:""}))',
    refused: true,
  },
  {
    id: 'regexp-like-explicit-flags',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:true,source:"fixed",flags:""} as never,error as never).flags;}',
    invocation: 'frames(Object.assign(new Error("i"),{name:""}))',
    refused: true,
  },
  {
    id: 'omitted-source-flags',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:true,flags:error} as never).flags;}',
    invocation: 'frames(Object.assign(new Error("i"),{name:""}))',
    refused: true,
  },
  {
    id: 'call-same-constructor-early-return',
    source:
      'function frames(error:Error){return RegExp({constructor:RegExp,[Symbol.match]:true,source:error,flags:""} as never).flags;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'false-match-ignores-source',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:false,source:error,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'zero-match-ignores-source',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:0,source:error,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'absent-match-ignores-source',
    source:
      'function frames(error:Error){return new RegExp({source:error,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'explicit-flags-ignore-pattern-flags',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:true,source:"fixed",flags:error} as never,"i").flags;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'changed-pattern',
    source:
      'function frames(error:Error){const pattern={[Symbol.match]:true,source:error,flags:""};pattern.source=new Error("fixed");return new RegExp(pattern as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'prior-application-effect',
    source:
      'function frames(error:Error){Object.assign(error,{toString:()=>"fixed"});return new RegExp({[Symbol.match]:true,source:error,flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'ignored-tail-effect',
    source:
      'function frames(error:Error){return (RegExp as(...args:unknown[])=>RegExp)({[Symbol.match]:true,source:error,flags:""},undefined,Object.assign(error,{toString:()=>"fixed"})).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-constructor',
    source:
      'function frames(error:Error){const RegExp=(_value:unknown)=>({source:"fixed"});return RegExp({[Symbol.match]:true,source:error,flags:""}).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'locally-constructed-source',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:true,source:new Error("ours"),flags:""} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'ordinary-pattern-data',
    source:
      'function frames(error:Error){return new RegExp({[Symbol.match]:true,source:"fixed",flags:"i"} as never).source;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('regexp-like protocol readers', () => {
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

describe('shared regexp-like protocol', () => {
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
