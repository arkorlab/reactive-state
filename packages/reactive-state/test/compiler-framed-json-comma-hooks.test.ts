import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A proved comma-prefix native hook write precedes JSON toJSON and property-list selection. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-effectful-prototype-hook',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["failure","stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'selected-message-origin',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["message"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'root-whole-alias',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};const saved=value;return JSON.stringify(saved,(Object.assign(Object.getPrototypeOf(saved),{toJSON:()=>error}),["failure","stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'prototype-whole-alias',
    source:
      'function frames(error:Error){const prototype={toJSON():unknown{return"fixed";}};const value={__proto__:prototype,failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["failure","stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-assign-alias',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};const assign=Object.assign;return JSON.stringify(value,(assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["failure","stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-prototype-reader-alias',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};const prototypeOf=Object.getPrototypeOf;return JSON.stringify(value,(Object.assign(prototypeOf(value),{toJSON:()=>error}),["failure","stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-json-alias',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};const stringify=JSON.stringify;return stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["failure","stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'method-value-hook',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON(){return error;}}),["failure","stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'fresh-error-hook',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>new Error("ours")}),["failure","stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-json-call',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify.call(null,value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-json-apply',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify.apply(null,[value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["stack"])]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-json-reflect',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return Reflect.apply(JSON.stringify,null,[value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["stack"])]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'data-hook-stays-data',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>"fixed"}),["failure","stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'excluded-error-keys',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["failure"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-root-hook-shadows-prototype',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"before";}},toJSON(){return"fixed";},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["failure","stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'comma-writes-error-words',
    source:
      'function frames(error:Error){const value=error;return JSON.stringify(value,(Object.assign(error,{stack:"fixed"}),["stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'earlier-error-word-write',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'ignored-json-tail-writes-words',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return(JSON.stringify as(...args:unknown[])=>string)(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["stack"]),0,Object.assign(error,{stack:"fixed"}));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'boxed-key-conversion-writes-words',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};const key=new String("stack");key.toString=()=>{Object.assign(error,{stack:"fixed"});return"stack";};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),[key] as never));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'returned-error-effect-keeps-opacity',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>Object.assign(error,{stack:"fixed"})}),["stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-prototype-setter-is-effectful',
    source:
      'function frames(error:Error){const prototype={get toJSON():()=>Error{return()=>error;},set toJSON(_fn:()=>Error){Object.assign(error,{stack:"fixed"});}};const value={__proto__:prototype,failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-assign-stays-local',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};const assign=(target:unknown,_source:unknown)=>target;return JSON.stringify(value,(assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["failure","stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'captured-prepare-keeps-opacity',
    source:
      'function frames(error:Error){function collect(error:Error,prepare:()=>void){prepare();const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["stack"]));}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'returned-error-whole-alias',
    source:
      'function frames(error:Error){const saved=error;const value={__proto__:{toJSON():unknown{return"fixed";}},failure:saved};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>saved}),["stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'primitive-property-list-alias',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};const fields=["failure","stack"];return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),fields));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returned-error-hook-is-not-called-twice',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["failure","stack"]));}',
    invocation: 'frames(Object.assign(new Error("ours"),{toJSON(){return"fixed";}}))',
    refused: true,
  },
  {
    id: 'gap-coercion-rewrites-selected-words',
    source:
      'function frames(error:Error){function collect(error:Error,gap:unknown){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["stack"]),gap as string);}return collect(error,Object.assign(new Number(0),{valueOf(){Object.assign(error,{stack:"fixed"});return 0;}}));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'ignored-tail-computed-key-rewrites-words',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return(JSON.stringify as(...args:unknown[])=>string)(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["stack"]),0,{[Object.assign(error,{stack:"fixed"}).stack as string]:0});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'earlier-selected-message-write',
    source:
      'function frames(error:Error){Object.assign(error,{message:"fixed"});const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["message"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'later-holder-own-hook-shadow',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};Object.assign(value,{toJSON(){return"fixed";}});return JSON.stringify(value,(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),["failure","stack"]));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('comma JSON hook readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'defined-accessors.ts', source);
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

describe('shared comma JSON hook admissions', () => {
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
