import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Runtime array property keys retain native Error word conversions. */
const CASES = [
  {
    id: 'array-key-object-literal',
    source: 'function frames(error:Error){return Object.keys({[[error] as never]:1})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-caught',
    source:
      'function frames(){try{JSON.parse("{");return "fixed";}catch(error){return Object.keys({[[error]as never]:1})[0];}}',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-const-alias',
    source:
      'function frames(error:Error){const saved=[error];return Object.keys({[saved as never]:1})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-nested',
    source: 'function frames(error:Error){return Object.keys({[[[error]] as never]:1})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-literal-prefix',
    source: 'function frames(error:Error){return Object.keys({[["prefix",error] as never]:1})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-literal-spread',
    source: 'function frames(error:Error){return Object.keys({[[...[error]] as never]:1})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-element-read',
    source:
      'function frames(error:Error){const box:Record<string,string>={"Error: ours":"kept"};return box[[error]as never];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-element-write',
    source:
      'function frames(error:Error){const box:Record<string,number>={};box[[error]as never]=1;return Object.keys(box)[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-element-delete',
    source:
      'function frames(error:Error){const box:Record<string,number>={"Error: ours":1};delete box[[error]as never];return Object.keys(box).length;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-in',
    source: 'function frames(error:Error){return ([error]as never) in {}; }',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-object-method',
    source:
      'function frames(error:Error){return Object.keys({[[error]as never](){return 1;}})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-object-getter',
    source:
      'function frames(error:Error){return Object.keys({get [[error]as never](){return 1;}})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-native-has-own',
    source: 'function frames(error:Error){return Object.hasOwn({},[error]as never);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-native-reflect-get',
    source:
      'function frames(error:Error){return Reflect.get({"Error: ours":"kept"},[error]as never);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-native-call',
    source: 'function frames(error:Error){return Object.hasOwn.call(null,{},[error]as never);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-native-apply',
    source: 'function frames(error:Error){return Object.hasOwn.apply(null,[{},[error]as never]);}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-key-fixed-primitive-data',
    source: 'function frames(error:Error){return Object.keys({[["fixed"] as never]:1})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-local-error-data',
    source:
      'function frames(error:Error){return Object.keys({[[new Error("fixed")] as never]:1})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-own-to-string-data',
    source:
      'function frames(error:Error){const saved=[error];saved.toString=()=>"fixed";return Object.keys({[saved as never]:1})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-own-join-data',
    source:
      'function frames(error:Error){const saved=[error];saved.join=()=>"fixed";return Object.keys({[saved as never]:1})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-own-symbol-conversion-data',
    source:
      'function frames(error:Error){const saved=Object.assign([error],{[Symbol.toPrimitive]:()=>"fixed"});return Object.keys({[saved as never]:1})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-own-error-conversion-data',
    source:
      'function frames(error:Error){Object.defineProperty(error,"toString",{value:()=>"fixed"});return Object.keys({[[error] as never]:1})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-ignored-evaluated-tail-data',
    source:
      'function frames(error:Error){return(Object.hasOwn as(...args:unknown[])=>boolean)({fixed:1},[error],Object.defineProperty(error,"toString",{value:()=>"fixed"}));}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-in-rhs-effect-data',
    source:
      'function frames(error:Error){return([error]as never) in (Object.defineProperty(error,"toString",{value:()=>"fixed"}),{fixed:1});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-element-target-effect-data',
    source:
      'function frames(error:Error){return(Object.defineProperty(error,"toString",{value:()=>"fixed"}),{fixed:1})[[error]as never];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-prior-part-coercion-data',
    source:
      'function frames(error:Error){const head={toString(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return"prefix";}};return Object.keys({[[head,error]as never]:1})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-prior-callback-bridge-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return Object.keys({[[value]as never]:1})[0];}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-captured-owner-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return Object.keys({[[value]as never]:1})[0];}return read();}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-local-error-shadow-data',
    source:
      'function frames(){class Error{toString(){return"fixed";}}return Object.keys({[[new Error()]as never]:1})[0];}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
  {
    id: 'array-key-ignored-value-data',
    source: 'function frames(error:Error){return Object.keys({fixed:[error]})[0];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'optional-null-array-key-not-evaluated-data',
    source:
      'function frames(error:Error){return(null as Record<string,string>|null)?.[[error]as never]??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'optional-present-array-key-converted-control',
    source:
      'function frames(error:Error){return({"Error: ours":"kept"}as Record<string,string>|null)?.[[error]as never]??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'optional-const-undefined-array-key-data',
    source:
      'function frames(error:Error){const target=undefined as Record<string,string>|undefined;return target?.[[error]as never]??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'optional-unknown-array-key-opaque',
    source:
      'function frames(error:Error,target?:Record<string,string>){return target?.[[error]as never]??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'optional-continuous-null-array-key-data',
    source:
      'function frames(error:Error){const target=null as {nested:Record<string,string>}|null;return target?.nested[[error]as never]??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'optional-const-present-array-key-control',
    source:
      'function frames(error:Error){const target={"Error: ours":"kept"} as Record<string,string>|null;return target?.[[error]as never]??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'key-array-default-source',
    source:
      'function frames(error:Error){const box:Record<string,number>={};const {a=Object.keys(box)[0]}=(box[[error]as never]=1,{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'key-array-default-source-data',
    source:
      'function frames(){const box:Record<string,number>={};const {a=Object.keys(box)[0]}=(box[["fixed"]as never]=1,{} as {a?:string});return a;}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
] as const;

describe('runtime array property key readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'property-key-array.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('runtime array property key admissions', () => {
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
