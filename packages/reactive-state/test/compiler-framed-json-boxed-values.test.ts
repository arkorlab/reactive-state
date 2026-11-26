import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native primitive wrappers normalize after toJSON and before listed properties. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-number-wrapper',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new Number(1),{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reported-string-wrapper',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new String("fixed"),{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reported-boolean-wrapper',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new Boolean(true),{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'global-constructor',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new globalThis.Number(1),{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'constructor-whole-alias',
    source:
      'function frames(error:Error){const Box=Number;return JSON.stringify(Object.assign(new Box(1),{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'result-whole-alias',
    source:
      'function frames(error:Error){const value=Object.assign(new Number(1),{failure:error});return JSON.stringify(value,["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'target-whole-alias',
    source:
      'function frames(error:Error){const box=new Number(1);return JSON.stringify(Object.assign(box,{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'target-chain-alias',
    source:
      'function frames(error:Error){const box=new Number(1);const alias=box;return JSON.stringify(Object.assign(alias,{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'nested-assign',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(Object.assign(new Number(1),{failure:error}),{n:2}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'wrapper-in-array',
    source:
      'function frames(error:Error){return JSON.stringify([Object.assign(new Number(1),{failure:error})],["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'wrapper-in-object',
    source:
      'function frames(error:Error){return JSON.stringify({box:Object.assign(new Number(1),{failure:error})},["box","failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'defined-data-on-number',
    source:
      'function frames(error:Error){return JSON.stringify(Object.defineProperty(new Number(1),"failure",{value:error,enumerable:true}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'defined-many-on-boolean',
    source:
      'function frames(error:Error){return JSON.stringify(Object.defineProperties(new Boolean(true),{failure:{value:error,enumerable:true}}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'native-json-call',
    source:
      'function frames(error:Error){return JSON.stringify.call(null,Object.assign(new Number(1),{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'native-json-apply',
    source:
      'function frames(error:Error){return JSON.stringify.apply(null,[Object.assign(new Number(1),{failure:error}),["failure","stack"]]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'native-json-reflect',
    source:
      'function frames(error:Error){return Reflect.apply(JSON.stringify,null,[Object.assign(new Number(1),{failure:error}),["failure","stack"]]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'native-json-alias',
    source:
      'function frames(error:Error){const stringify=JSON.stringify;return stringify(Object.assign(new Number(1),{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'primitive-gap',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new Number(1),{failure:error}),["failure","stack"],0);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'empty-number-construction',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new Number(),{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'noncallable-own-tojson',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new Number(1),{failure:error,toJSON:0}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-tojson-this',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new Number(1),{failure:error,toJSON(){return this;}}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-tojson-data',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new Number(1),{failure:error,toJSON(){return 7;}}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-tojson-error',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new Number(1),{failure:error,toJSON(){return error;}}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-tojson-object',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new Number(1),{failure:error,toJSON(){return{failure:error};}}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'ordinary-object-keeps-fields',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign({},{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-number-shadow',
    source:
      'function frames(error:Error){const Number=class{constructor(_value:number){}};return JSON.stringify(Object.assign(new Number(1),{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-string-shadow',
    source:
      'function frames(error:Error){const String=class{constructor(_value:string){}};return JSON.stringify(Object.assign(new String("fixed"),{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'ordinary-data-field',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new Number(1),{failure:{stack:"fixed"}}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'string-own-conversion',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new String("fixed"),{failure:error,toString(){return error.stack??"fixed";}}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'string-own-symbol-conversion',
    source:
      'function frames(error:Error){return JSON.stringify(Object.assign(new String("fixed"),{failure:error,[Symbol.toPrimitive](){return error.stack??"fixed";}}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'prefix-mutates-native-prototype',
    source:
      'function frames(error:Error){function prepare(){Object.defineProperty(Number.prototype,"toJSON",{value(){return error;},configurable:true});}prepare();return JSON.stringify(Object.assign(new Number(1),{failure:error}),["failure","stack"]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'gap-mutates-box',
    source:
      'function frames(error:Error){const value=Object.assign(new String("fixed"),{failure:error});const gap=new Number(0);gap.valueOf=()=>{value.toString=()=>error.stack??"fixed";return 0;};return JSON.stringify(value,["failure","stack"],gap as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'key-conversion-mutates-box',
    source:
      'function frames(error:Error){const value=Object.assign(new String("fixed"),{failure:error});const key=new String("failure");key.toString=()=>{value.toString=()=>error.stack??"fixed";return"failure";};return JSON.stringify(value,[key,"stack"] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'evaluated-tail-mutates-box',
    source:
      'function frames(error:Error){const value=Object.assign(new String("fixed"),{failure:error});return(JSON.stringify as(...args:unknown[])=>string)(value,["failure","stack"],0,value.toString=()=>error.stack??"fixed");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'bad-box-input-keeps-thrown-stack',
    source:
      'function frames(error:Error){try{return JSON.stringify(Object.assign(new Number(Symbol("bad")),{failure:error}),["failure","stack"]);}catch(cause){return(cause as Error).stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boxed-value-default-source-prepare',
    source:
      'function frames(error:Error){function prepare(){Object.defineProperty(Number.prototype,"toJSON",{value(){return error;},configurable:true});}let a;({a=JSON.stringify(Object.assign(new Number(1),{failure:error}),["failure","stack"])}=(prepare(),{} as {a?:string}));return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boxed-value-default-source-none',
    source:
      'function frames(error:Error){let a;({a=JSON.stringify(Object.assign(new Number(1),{failure:error}),["failure","stack"])}={} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('boxed JSON value readers', () => {
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

describe('shared boxed JSON value admissions', () => {
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
