import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A member path read of a variable or a construction holds what was put on that path. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'const-object-member',
    source: 'function frames(error:Error){const box={x:error};return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-object-fresh-error',
    source: 'function frames(){const box={x:new Error("ours")};return box.x.stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'module-const-object',
    source: 'const box={x:new Error("ours")};function frames(){return box.x.stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'let-object-member',
    source: 'function frames(error:Error){let box={x:error};return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reassigned-object',
    source:
      'function frames(error:Error){let box:Record<string,any>={x:"fixed"};box={x:error};return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'member-write-object',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:"fixed"};box.x=error;return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'assign-write-object',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:"fixed"};Object.assign(box,{x:error});return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'aliased-write-object',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:"fixed"};const alias=box;alias.x=error;return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias-read-object',
    source:
      'function frames(error:Error){const box={x:error};const alias=box;return alias.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-object-path',
    source: 'function frames(error:Error){const box={inner:{x:error}};return box.inner.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'destructured-holder',
    source: 'function frames(error:Error){const{inner}={inner:{x:error}};return inner.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proxy-member-path',
    source: 'function frames(error:Error){return new Proxy({x:error},{}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proxy-alias-member-path',
    source:
      'function frames(error:Error){const proxy=new Proxy({x:error},{});return proxy.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-holder-path',
    source:
      'function frames(error:Error,flag:boolean){return(flag?{x:error}:{x:{stack:"fixed"}}).x.stack;}',
    invocation: 'frames(new Error("ours"),true)',
    refused: true,
  },
  {
    id: 'holder-words',
    source: 'function frames(error:Error){const box={x:error};return String(box.x);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'closure-write-object',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:"fixed"};function change(){box.x=error;}change();return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'forwarded-const-target',
    source:
      'function frames(error:Error){const target={x:error};return new Proxy(target,{get:Reflect.get}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'branch-overwrite-keeps-original',
    source:
      'function frames(error:Error,flag:boolean){const box:Record<string,any>={x:error};if(flag)box.x={stack:"fixed"};return box.x.stack;}',
    invocation: 'frames(new Error("ours"),false)',
    refused: true,
  },
  {
    id: 'other-member-write-keeps-original',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:error,y:"a"};box.y="b";return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'object-identity-member-path',
    source:
      'function frames(error:Error){return(new Object({inner:error})as{inner:{stack?:string}}).inner.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'loop-condition-member-write',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:{stack:"fixed"}};let result="";let i=0;while((result=box.x.stack,box.x=error,i++<1)){}return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'const-object-data',
    source: 'function frames(error:Error){const box={x:{stack:"fixed"}};return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'const-object-other-member',
    source:
      'function frames(error:Error){const box={x:error,y:{stack:"fixed"}};return box.y.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-words-holder',
    source: 'function frames(error:Error){const box={x:new Error("fixed")};return box.x.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'later-write-not-reached',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:{stack:"fixed"}};const result=box.x.stack;box.x=error;return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'other-member-write',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:{stack:"fixed"}};box.y=error;return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'definite-overwrite-data',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:error};box.x={stack:"fixed"};return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'alias-overwrite-data',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:error};const alias=box;alias.x={stack:"fixed"};return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'let-overwrite-data',
    source:
      'function frames(error:Error){let box:Record<string,any>={x:error};box.x={stack:"fixed"};return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'assign-overwrite-data',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:error};Object.assign(box,{x:{stack:"fixed"}});return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'define-overwrite-data',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:error};Object.defineProperty(box,"x",{value:{stack:"fixed"}});return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reassigned-let-data',
    source:
      'function frames(error:Error){let box:Record<string,any>={x:error};box={x:{stack:"fixed"}};return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'branch-reassigned-keeps-error',
    source:
      'function frames(error:Error,flag:boolean){let box:Record<string,any>={x:error};if(flag)box={x:{stack:"fixed"}};return box.x.stack;}',
    invocation: 'frames(new Error("ours"),false)',
    refused: true,
  },
  {
    id: 'proxy-holder-write-keeps-error',
    source:
      'function frames(error:Error){const box:Record<string,any>=new Proxy({x:error},{set(){return true;}});box.x={stack:"fixed"};return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'direct-literal-member',
    source: 'function frames(error:Error){return({x:error}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'member-default-source-write',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:{stack:"fixed"}};const {a=box.x.stack}=(box.x=error,{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'member-default-source-other',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:{stack:"fixed"}};const other:Record<string,any>={};const {a=box.x.stack}=(other.x=error,{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'member-heritage-write',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:{stack:"fixed"}};class Base{}class Holder extends (box.x=error,Base){}void Holder;return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'member-heritage-other',
    source:
      'function frames(error:Error){const box:Record<string,any>={x:{stack:"fixed"}};const other:Record<string,any>={};class Base{}class Holder extends (other.x=error,Base){}void Holder;return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'member-instantiation-write',
    source:
      'function pick<T>(value:T){return value;}function frames(error:Error){const box:Record<string,any>={x:{stack:"fixed"}};const picked=(box.x=error,pick)<string>;void picked;return box.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('held member readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'held-members.ts', source);
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

describe('shared held member admissions', () => {
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
