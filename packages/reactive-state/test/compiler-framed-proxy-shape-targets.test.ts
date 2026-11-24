import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'reported-names-ignore-get',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(error,{get(){return"fixed";}}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflect-keys-ignore-get',
    source:
      'function frames(error:Error){return Reflect.ownKeys(new Proxy(error,{get(){return"fixed";}}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'hasown-stack-ignores-get',
    source:
      'function frames(error:Error){return Object.hasOwn(new Proxy(error,{get(){return"fixed";}}),"stack");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'hasown-filename-ignores-get',
    source:
      'function frames(error:Error){return Object.hasOwn(new Proxy(error,{get(){return"fixed";}}),"fileName");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-prototype-own',
    source:
      'function frames(error:Error){return Object.prototype.hasOwnProperty.call(new Proxy(error,{get(){return"fixed";}}),"stack");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflected-prototype-own',
    source:
      'function frames(error:Error){return Reflect.apply(Object.prototype.hasOwnProperty,new Proxy(error,{get(){return"fixed";}}),["fileName"]);}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'static-borrowed-own',
    source:
      'function frames(error:Error){return Object.hasOwn.call(null,new Proxy(error,{get(){return"fixed";}}),"stack");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-operation-alias',
    source:
      'function frames(error:Error){const names=Object.getOwnPropertyNames;return names(new Proxy(error,{get(){return"fixed";}}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-constructor-alias',
    source:
      'function frames(error:Error){const Make=Proxy;return Object.getOwnPropertyNames(new Make(error,{get(){return"fixed";}}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-proxy-alias',
    source:
      'function frames(error:Error){const proxy=new Proxy(error,{get(){return"fixed";}});return Object.getOwnPropertyNames(proxy);}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-handler-alias',
    source:
      'function frames(error:Error){const handler:ProxyHandler<Error>={get(){return"fixed";}};return Object.getOwnPropertyNames(new Proxy(error,handler));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-unrelated-trap',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(error,{["get"](){return"fixed";}}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'constructor-argument-spread',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(...([error,{get(){return"fixed";}}]as const)));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'shape-call-argument-spread',
    source:
      'function frames(error:Error){return Object.hasOwn(...([new Proxy(error,{get(){return"fixed";}}),"stack"]as const));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'undefined-ownkeys-forwards',
    source:
      'function frames(error:Error){return Reflect.ownKeys(new Proxy(error,{get(){return"fixed";},ownKeys:undefined}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'null-ownkeys-forwards',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(error,{get(){return"fixed";},ownKeys:null as never}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'undefined-descriptor-forwards',
    source:
      'function frames(error:Error){return Object.hasOwn(new Proxy(error,{get(){return"fixed";},getOwnPropertyDescriptor:undefined}),"stack");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fresh-error-layout',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(new Error("ours"),{get(){return"fixed";}}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-native-proxies',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(new Proxy(error,{get(){return"inside";}}),{get(){return"outside";}}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unused-get-parameters',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(error,{get(_target,_key){return"fixed";}}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fixed-ownkeys-empty',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(error,{get(){return"fixed";},ownKeys(){return[];}}));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fixed-ownkeys-list',
    source:
      'function frames(error:Error){return Reflect.ownKeys(new Proxy(error,{get(){return"fixed";},ownKeys(){return["fixed"];}}));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'descriptor-trap-hides-presence',
    source:
      'function frames(error:Error){return Object.hasOwn(new Proxy(error,{get(){return"fixed";},getOwnPropertyDescriptor(){return undefined;}}),"stack");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'descriptor-trap-fixed-presence',
    source:
      'function frames(error:Error){return Object.hasOwn(new Proxy(error,{get(){return"fixed";},getOwnPropertyDescriptor(){return{value:1,writable:true,enumerable:true,configurable:true};}}),"fileName");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ordinary-target-keys',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy({fixed:1},{get(){return"fixed";}}));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ordinary-target-presence',
    source:
      'function frames(error:Error){return Object.hasOwn(new Proxy({fixed:1},{get(){return"fixed";}}),"stack");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ordinary-message-presence',
    source:
      'function frames(error:Error){return Object.hasOwn(new Proxy(error,{get(){return"fixed";}}),"message");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-proxy-shadow',
    source:
      'function frames(error:Error){const Proxy=class{fixed=1;constructor(_target:unknown,_handler:unknown){}};return Object.getOwnPropertyNames(new Proxy(error,{get(){return"fixed";}}));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-shape-operation-shadow',
    source:
      'function frames(error:Error){const Object={getOwnPropertyNames(_value:unknown){return["fixed"];}};return Object.getOwnPropertyNames(new Proxy(error,{get(){return"fixed";}}));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-error-type-shadow',
    source:
      'type Error={stack:string};function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(error,{get(){return"fixed";}}));}',
    reader: false,
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'ordinary-get-stays-fixed',
    source: 'function frames(error:Error){return new Proxy(error,{get(){return"fixed";}}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'prior-handler-write-keeps-fixed',
    source:
      'function frames(error:Error){const handler:ProxyHandler<Error>={get(){return"fixed";}};handler.ownKeys=()=>["fixed"];return Object.getOwnPropertyNames(new Proxy(error,handler));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-shape-tail-changes-handler',
    source:
      'function frames(error:Error){const handler:ProxyHandler<Error>={get(){return"fixed";}};const proxy=new Proxy(error,handler);return(Object.getOwnPropertyNames as(...args:unknown[])=>string[])(proxy,Object.assign(handler,{ownKeys:()=>["fixed"]}));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-constructor-tail-changes-handler',
    source:
      'function frames(error:Error){const handler:ProxyHandler<Error>={get(){return"fixed";}};return Object.getOwnPropertyNames(new(Proxy as new(...args:unknown[])=>Error)(error,handler,Object.assign(handler,{ownKeys:()=>["fixed"]})));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'coercive-key-changes-handler',
    source:
      'function frames(error:Error){const handler:ProxyHandler<Error>={get(){return"fixed";}};const proxy=new Proxy(error,handler);const key={toString(){handler.getOwnPropertyDescriptor=()=>undefined;return"stack";}};return Object.hasOwn(proxy,key as unknown as PropertyKey);}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'prior-proxy-set-changes-handler',
    source:
      'function frames(error:Error){const handler:ProxyHandler<Error>={get(){return"fixed";},set(){this.ownKeys=()=>["fixed"];return true;}};const proxy=new Proxy(error,handler);Reflect.set(proxy,"value",1);return Object.getOwnPropertyNames(proxy);}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unrelated-get-accessor-not-invoked',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(error,{get get(){return()=>"fixed";}}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ownkeys-accessor-keeps-fixed',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(error,{get(){return"fixed";},get ownKeys(){return()=>["fixed"];}}));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'inherited-ownkeys-keeps-fixed',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(error,({__proto__:{ownKeys(){return["fixed"];}},get(){return"fixed";}}as ProxyHandler<Error>&{__proto__:unknown})));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-presence-ignores-ownkeys',
    source:
      'function frames(error:Error){return Object.hasOwn(new Proxy(error,{get(){return"fixed";},ownKeys(){return[];}}),"stack");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'names-ignore-descriptor-trap',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(error,{get(){return"fixed";},getOwnPropertyDescriptor(){return undefined;}}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-symbol-key-stays-data',
    source:
      'function frames(error:Error){return Object.hasOwn(new Proxy(error,{get(){return"fixed";}}),Symbol.iterator);}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('operation-specific Proxy shape readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-reduce.ts', source);
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

describe('operation-specific Proxy shape shared', () => {
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
