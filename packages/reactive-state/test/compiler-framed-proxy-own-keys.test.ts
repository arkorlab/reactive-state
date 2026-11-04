import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Closed Proxy own-key traps retain their fixed lists independently of target Error layout. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
  readonly files?: Readonly<Record<string, string>>;
}

const CASES: readonly Case[] = [
  {
    id: 'reflect-empty-trap',
    source:
      'function words(){return Reflect.ownKeys(new Proxy(new Error("ours"),{ownKeys(){return[];}})).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'names-empty-trap',
    source:
      'function words(){return Object.getOwnPropertyNames(new Proxy(new Error("ours"),{ownKeys(){return[];}})).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-fixed-list',
    source:
      'function words(){return Reflect.ownKeys(new Proxy(new Error("ours"),{ownKeys(){return["fixed"];}}))[0];}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'names-fixed-list',
    source:
      'function words(){return Object.getOwnPropertyNames(new Proxy(new Error("ours"),{ownKeys(){return["fixed"];}}))[0];}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-literal-stack-data',
    source:
      'function words(){return Reflect.ownKeys(new Proxy(new Error("ours"),{ownKeys(){return["stack"];}}))[0];}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-arrow-trap',
    source:
      'function words(){return Reflect.ownKeys(new Proxy(new Error("ours"),{ownKeys:()=>[]})).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'names-function-trap',
    source:
      'function words(){return Object.getOwnPropertyNames(new Proxy(new Error("ours"),{ownKeys:function(){return["fixed"];}}))[0];}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-template-key-list',
    source:
      'function words(){return Reflect.ownKeys(new Proxy(new Error("ours"),{ownKeys(){return[`fixed`];}}))[0];}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-constructor-alias',
    source:
      'function words(){const Make=Proxy;return Reflect.ownKeys(new Make(new Error("ours"),{ownKeys(){return[];}})).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-operation-alias',
    source:
      'function words(){const keys=Reflect.ownKeys;return keys(new Proxy(new Error("ours"),{ownKeys(){return[];}})).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-proxy-alias',
    source:
      'function words(){const proxy=new Proxy(new Error("ours"),{ownKeys(){return[];}});return Reflect.ownKeys(proxy).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'names-proxy-alias-chain',
    source:
      'function words(){const original=new Proxy(new Error("ours"),{ownKeys(){return["fixed"];}});const proxy=original;return Object.getOwnPropertyNames(proxy)[0];}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-borrowed-call',
    source:
      'function words(){return Reflect.ownKeys.call(null,new Proxy(new Error("ours"),{ownKeys(){return[];}})).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'names-borrowed-apply',
    source:
      'function words(){return Object.getOwnPropertyNames.apply(null,[new Proxy(new Error("ours"),{ownKeys(){return["fixed"];}})])[0];}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-native-apply',
    source:
      'function words(){return Reflect.apply(Reflect.ownKeys,null,[new Proxy(new Error("ours"),{ownKeys(){return[];}})]).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-supplied-error',
    source:
      'function words(){function collect(error:Error){return Reflect.ownKeys(new Proxy(error,{ownKeys(){return[];}})).length;}return collect(new Error("ours"));}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-plain-target',
    source:
      'function words(){return Reflect.ownKeys(new Proxy({value:1},{ownKeys(){return[];}})).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'names-local-proxy-shadow',
    source:
      'function words(){const Proxy=class{constructor(_target:unknown,_handler:unknown){} };return Object.getOwnPropertyNames(new Proxy(new Error("ours"),{ownKeys(){return[];}})).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'names-local-operation-shadow',
    source:
      'function words(){const Object={getOwnPropertyNames(_value:unknown){return["fixed"];}};return Object.getOwnPropertyNames(new Proxy(new Error("ours"),{ownKeys(){return[];}}))[0];}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-computed-own-trap-pin',
    source:
      'function words(){return Reflect.ownKeys(new Proxy(new Error("ours"),{["ownKeys"](){return[];}})).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-get-and-own-keys-pin',
    source:
      'function words(){return Reflect.ownKeys(new Proxy(new Error("ours"),{get(){return"fixed";},ownKeys(){return[];}})).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-native-error-pin',
    source: 'function words(){return Reflect.ownKeys(new Error("ours")).includes("message");}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'names-empty-handler-pin',
    source:
      'function words(){return Object.getOwnPropertyNames(new Proxy(new Error("ours"),{})).includes("message");}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'reflect-undefined-own-trap-pin',
    source:
      'function words(){return Reflect.ownKeys(new Proxy(new Error("ours"),{ownKeys:undefined})).includes("message");}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'names-null-own-trap-pin',
    source:
      'function words(){return Object.getOwnPropertyNames(new Proxy(new Error("ours"),{ownKeys:null as never})).includes("message");}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'reflect-forwarding-trap-pin',
    source:
      'function words(){return Reflect.ownKeys(new Proxy(new Error("ours"),{ownKeys(target){return Reflect.ownKeys(target);}})).includes("message");}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'names-unknown-result-trap-pin',
    source:
      'function words(){const keys=["message"];return Object.getOwnPropertyNames(new Proxy(new Error("ours"),{ownKeys(){return keys;}}))[0];}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'reflect-prior-proxy-use-pin',
    source:
      'function words(){const proxy=new Proxy(new Error("ours"),{ownKeys(){return[];},set(target){this.ownKeys=()=>Reflect.ownKeys(target);return true;}});Reflect.set(proxy,"x",1);return Reflect.ownKeys(proxy).includes("message");}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'reflect-ignored-tail-use-pin',
    source:
      'function words(){const proxy=new Proxy(new Error("ours"),{ownKeys(){return[];},set(target){this.ownKeys=()=>Reflect.ownKeys(target);return true;}});return (Reflect.ownKeys as (...args:unknown[])=>PropertyKey[])(proxy,Reflect.set(proxy,"x",1)).includes("message");}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'reflect-captured-proxy-use-pin',
    source:
      'function words(){const proxy=new Proxy(new Error("ours"),{ownKeys(){return[];},set(target){this.ownKeys=()=>Reflect.ownKeys(target);return true;}});function prepare(){Reflect.set(proxy,"x",1);}prepare();return Reflect.ownKeys(proxy).includes("message");}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'reflect-inherited-handler-pin',
    source:
      'function words(){return Reflect.ownKeys(new Proxy(new Error("ours"),({__proto__:{ownKeys:()=>[]}} as ProxyHandler<Error>&{__proto__:{ownKeys:()=>string[]}}))).length;}',
    invocation: 'words()',
    refused: false,
  },
  {
    id: 'reflect-symbol-own-list',
    source:
      'function words(){return Reflect.ownKeys(new Proxy(new Error("ours"),{ownKeys(){return[Symbol.for("fixed")];}})).length;}',
    invocation: 'words()',
    refused: true,
  },
  {
    id: 'presence-ignores-own-keys-pin',
    source:
      'function words(){return Object.hasOwn(new Proxy(new Error("ours"),{ownKeys(){return[];}}),"stack");}',
    invocation: 'words()',
    refused: true,
  },
];

describe('proxy own-key trap readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'proxy-own-keys.ts', source);
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

describe('shared Proxy own-key trap admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, files }) => {
    const app = await application({
      ...files,
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
