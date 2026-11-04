import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-written inherited JSON hooks replace the original receiver before listed field reads. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-inherited-method',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON(){return\'fixed\';}},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'inherited-arrow-field',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON:()=> \'fixed\'},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'inherited-function-field',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON:function(){return\'fixed\';}},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'whole-prototype-alias',
    source:
      'function frames(error:Error){const prototype={toJSON(){return\'fixed\';}};return JSON.stringify({__proto__:prototype,failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'whole-prototype-alias-chain',
    source:
      'function frames(error:Error){const prototype={toJSON(){return\'fixed\';}};const parent=prototype;return JSON.stringify({__proto__:parent,failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'whole-receiver-alias',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON(){return\'fixed\';}},failure:error};return JSON.stringify(value,["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'multi-level-prototype',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{__proto__:{toJSON(){return\'fixed\';}}},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'inherited-direct-getter',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{get toJSON(){return()=> \'fixed\';}},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'inherited-getter-setter-pair',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{get toJSON(){return()=> \'fixed\';},set toJSON(_value:unknown){}},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'inherited-data-record',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON(){return{stack:\'fixed\'};}},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'constant-hook-alias',
    source:
      'function frames(error:Error){const hook=()=> \'fixed\';return JSON.stringify({__proto__:{toJSON:hook},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'nearest-inherited-method',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{__proto__:{toJSON(){return error;}},toJSON(){return\'fixed\';}},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-method-shadows-inherited',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON(){return error;}},toJSON(){return\'fixed\';},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-undefined-shadows-inherited',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON(){return\'fixed\';}},toJSON:undefined,failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-noncallable-shadows-inherited',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON(){return\'fixed\';}},toJSON:false,failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-setter-shadows-inherited',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON(){return\'fixed\';}},set toJSON(_value:unknown){},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nearest-inherited-noncallable',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{__proto__:{toJSON(){return\'fixed\';}},toJSON:undefined},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-prototype-no-hook',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:null,failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-prototype-no-hook',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-return-original-this',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON(this:{failure:Error}){return this;}},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-this-member-original-receiver',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON(this:{failure:Error}){return this.failure;}},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-direct-error-result',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON(){return error;}},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'changed-prototype-alias-prior-boundary',
    source:
      'function frames(error:Error){const prototype={toJSON(){return error as unknown;}};Object.assign(prototype,{toJSON:()=> \'fixed\'});return JSON.stringify({__proto__:prototype,failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'dynamic-prototype-prior-boundary',
    source:
      'function frames(error:Error,prototype:{toJSON:()=>unknown}){return JSON.stringify({__proto__:prototype,failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"),{toJSON:()=>"fixed"})',
    refused: true,
  },
  {
    id: 'inherited-getter-uses-original-unsafe-hook',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{hook:()=> \'fixed\',get toJSON(){return this.hook;}},hook:()=>error,failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-getter-receiver-dependent-prior-boundary',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{hook:()=>error,get toJSON(){return this.hook;}},hook:()=> \'fixed\',failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-function-this-prior-boundary',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON:function(this:{failure:Error}){return this;}},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inherited-nested-this-result-prior-boundary',
    source:
      'function frames(error:Error){return JSON.stringify({__proto__:{toJSON(this:{failure:Error}){return{failure:this.failure};}},failure:error},["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'third-space-argument-replaces-inherited-hook',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,["failure","stack"],(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),0));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'quiet-third-space-sensitivity',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,["failure","stack"],0);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'third-space-adds-own-error-hook',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,["failure","stack"],(Object.assign(value,{toJSON:()=>error}),0));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'third-space-rewrites-through-whole-receiver-alias',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};const receiver=value;return JSON.stringify(receiver,["failure","stack"],(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),0));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'third-space-rewrites-known-prototype-alias',
    source:
      'function frames(error:Error){const prototype={toJSON():unknown{return"fixed";}};const value={__proto__:prototype,failure:error};return JSON.stringify(value,["failure","stack"],(Object.assign(prototype,{toJSON:()=>error}),0));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'quiet-string-space-sensitivity',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify(value,["failure","stack"],"  ");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reflect-apply-ignored-fourth-operand-rewrites-hook',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return Reflect.apply(JSON.stringify,JSON,[value,["failure","stack"],0,Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error})]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'quiet-reflect-apply-space-sensitivity',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return Reflect.apply(JSON.stringify,JSON,[value,["failure","stack"],0]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'function-call-space-rewrites-hook',
    source:
      'function frames(error:Error){const value={__proto__:{toJSON():unknown{return"fixed";}},failure:error};return JSON.stringify.call(JSON,value,["failure","stack"],(Object.assign(Object.getPrototypeOf(value),{toJSON:()=>error}),0));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('inherited JSON toJSON readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'inherited-tojson.ts', source);
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

describe('shared inherited JSON toJSON admissions', () => {
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
