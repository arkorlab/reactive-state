import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native boxed property-list keys use their closed source-written text conversions. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-own-safe',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"safe";return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'global-constructor-alias',
    source:
      'function frames(error:Error){const Box=globalThis.String;const key=new Box("stack");key.toString=()=>"safe";return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'boxed-whole-alias',
    source:
      'function frames(error:Error){const key=new String("stack");const alias=key;alias.toString=()=>"safe";return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'list-alias-before-write',
    source:
      'function frames(error:Error){const key=new String("stack");const list=[key];key.toString=()=>"safe";return JSON.stringify(new Error("ours"),list as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'nearest-own-write',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"stack";key.toString=()=>"safe";return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'constant-callback-alias',
    source:
      'function frames(error:Error){const key=new String("stack");const convert=()=>"safe";key.toString=convert;return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'computed-own-write',
    source:
      'function frames(error:Error){const key=new String("stack");key["toString"]=()=>"safe";return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'function-own-return',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=function(){return"safe";};return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'native-call',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"safe";return JSON.stringify.call(null,new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'native-apply',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"safe";return JSON.stringify.apply(null,[new Error("ours"),[key] as never]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'native-reflect-apply',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"safe";return Reflect.apply(JSON.stringify,null,[new Error("ours"),[key]]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'native-callee-alias',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"safe";const stringify=JSON.stringify;return stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'applied-list-before-write',
    source:
      'function frames(error:Error){const key=new String("stack");const args:[unknown,never]=[new Error("ours"),[key] as never];key.toString=()=>"safe";return JSON.stringify.apply(null,args);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-stack-keeps-private',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"stack";return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'safe-box-to-stack',
    source:
      'function frames(error:Error){const key=new String("safe");key.toString=()=>"stack";return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'number-box-to-stack',
    source:
      'function frames(error:Error){const key=new Number(1);key.toString=()=>"stack";return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'numeric-string-to-stack',
    source:
      'function frames(error:Error){const key=new String(12);key.toString=()=>"stack";return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'object-result-uses-valueof',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=(()=>({})) as unknown as()=>string;return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-result-uses-valueof',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=(async()=>"safe") as unknown as()=>string;return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generator-result-uses-valueof',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=(function*(){return"safe";}) as unknown as()=>string;return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'symbol-hook-precedes-tostring',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"safe";Object.defineProperty(key,Symbol.toPrimitive,{value:()=>"stack"});return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-prefix-preserves-stack',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"safe";function prepare(){key.toString=()=>"stack";}prepare();return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'evaluated-gap-write',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"safe";return JSON.stringify(new Error("ours"),[key] as never,(key.toString=()=>"stack",0));}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'evaluated-ignored-tail',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"safe";return(JSON.stringify as (...args:unknown[])=>string)(new Error("ours"),[key],0,key.toString=()=>"stack");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'later-write-not-at-call',
    source:
      'function frames(error:Error){const key=new String("stack");const output=JSON.stringify(new Error("ours"),[key] as never);key.toString=()=>"safe";return output;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'getter-conversion-keeps-stack',
    source:
      'function frames(error:Error){const key=new String("stack");Object.defineProperty(key,"toString",{get(){return()=>"stack";}});return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'supplied-error-message',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"message";return JSON.stringify(error,[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-error-message',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"message";return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'number-box-safe-data',
    source:
      'function frames(error:Error){const key=new Number(1);key.toString=()=>"safe";return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unchanged-box-stack',
    source:
      'function frames(error:Error){const key=new String("stack");return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'literal-safe-key',
    source:
      'function frames(error:Error){const key="safe";return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-constructor-shadow',
    source:
      'function frames(error:Error){const String=class{constructor(_value:string){}toString(){return"stack";}};const key=new String("stack");return JSON.stringify(new Error("ours"),[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'mixed-primitive-list',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"safe";return JSON.stringify(new Error("ours"),["message",key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'selected-error-own-stack-data',
    source:
      'function frames(error:Error){const key=new String("safe");key.toString=()=>"stack";Object.defineProperty(error,"stack",{value:"fixed"});return JSON.stringify(error,[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'ignored-tail-fixes-selected-error',
    source:
      'function frames(error:Error){const key=new String("safe");key.toString=()=>"stack";return(JSON.stringify as (...args:unknown[])=>string)(error,[key],0,Object.defineProperty(error,"stack",{value:"fixed"}));}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'earlier-callback-before-box-birth',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();const key=new String("safe");key.toString=()=>"stack";return JSON.stringify(value,[key] as never);}return collect(error,()=>{Object.defineProperty(error,"stack",{value:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'later-own-data-preserves-tojson',
    source:
      'function frames(error:Error){const key=new String("safe");key.toString=()=>"stack";Object.defineProperty(error,"toJSON",{value:()=>({stack:"fixed"})});return JSON.stringify(error,[key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'earlier-unchanged-box-conversion',
    source:
      'function frames(error:Error){const earlier=new Number(1);const key=new String("stack");key.toString=()=>"safe";return JSON.stringify(new Error("ours"),[earlier,key] as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'boxed-key-default-source-prepare',
    source:
      'function frames(error:Error){const key=new String("stack");key.toString=()=>"safe";function prepare(){key.toString=()=>"stack";}let a;({a=JSON.stringify(new Error("ours"),[key] as never)}=(prepare(),{} as {a?:string}));return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boxed-key-default-source-none',
    source:
      'function frames(){const key=new String("stack");key.toString=()=>"safe";let a;({a=JSON.stringify(new Error("ours"),[key] as never)}={} as {a?:string});return a;}',
    invocation: 'frames()',
    refused: false,
  },
];

describe('boxed JSON key readers', () => {
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

describe('shared boxed JSON key admissions', () => {
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
