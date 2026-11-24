import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A directly invoked literal method keeps its original quiet receiver. */
const CASES = [
  {
    id: 'listener-add-direct',
    source:
      'function frames(error:Error){const target=new EventTarget();let fired=false;target.addEventListener(error as never,()=>{fired=true;});target.dispatchEvent(new Event("Error: ours"));return fired;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-add-caught',
    source:
      'function frames(){try{JSON.parse("{");return false;}catch(error){const target=new EventTarget();target.addEventListener(error as never,()=>{});return true;}}',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-add-bracket',
    source:
      'function frames(error:Error){const target=new EventTarget();target["addEventListener"](error as never,()=>{});return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-target-alias',
    source:
      'function frames(error:Error){const target=new EventTarget();const alias=target;alias.addEventListener(error as never,()=>{});return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-constructor-alias',
    source:
      'function frames(error:Error){const Native=EventTarget;const target=new Native();target.addEventListener(error as never,()=>{});return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-add-native-call',
    source:
      'function frames(error:Error){const target=new EventTarget();EventTarget.prototype.addEventListener.call(target,error as never,()=>{});return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-add-native-apply',
    source:
      'function frames(error:Error){const target=new EventTarget();EventTarget.prototype.addEventListener.apply(target,[error as never,()=>{}]);return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-add-native-reflect',
    source:
      'function frames(error:Error){const target=new EventTarget();Reflect.apply(EventTarget.prototype.addEventListener,target,[error,()=>{}]);return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-remove-after-fixed-add',
    source:
      'function frames(error:Error){const target=new EventTarget();let fired=false;const handler=()=>{fired=true;};target.addEventListener("Error: ours",handler);target.removeEventListener(error as never,handler);target.dispatchEvent(new Event("Error: ours"));return fired;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-remove-native-call',
    source:
      'function frames(error:Error){const target=new EventTarget();const handler=()=>{};target.addEventListener("fixed",handler);EventTarget.prototype.removeEventListener.call(target,error as never,handler);return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-array-type-words',
    source:
      'function frames(error:Error){const target=new EventTarget();target.addEventListener([error] as never,()=>{});return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-finite-arguments',
    source:
      'function frames(error:Error){const target=new EventTarget();target.addEventListener(...[error as never,()=>{}] as const);return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-quiet-native-prefix',
    source:
      'function frames(error:Error){const target=new EventTarget();target.addEventListener("fixed",()=>{},false);target.removeEventListener("fixed",()=>{},false);target.addEventListener(error as never,()=>{});return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-fixed-type-data',
    source:
      'function frames(){const target=new EventTarget();target.addEventListener("fixed",()=>{});return "fixed";}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-local-error-words',
    source:
      'function frames(){const target=new EventTarget();target.addEventListener(new Error("fixed") as never,()=>{});return "fixed";}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-ignored-callback-error',
    source:
      'function frames(error:Error){const target=new EventTarget();target.removeEventListener("fixed",error as never);return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-ignored-options-error',
    source:
      'function frames(error:Error){const target=new EventTarget();target.addEventListener("fixed",()=>{},error as never);return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-own-method-data',
    source:
      'function frames(error:Error){const target=new EventTarget();target.addEventListener=()=>{};target.addEventListener(error as never,()=>{});return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-own-getter-data',
    source:
      'function frames(error:Error){const target=new EventTarget();Object.defineProperty(target,"addEventListener",{get(){return()=>{};}});target.addEventListener(error as never,()=>{});return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-own-error-conversion-data',
    source:
      'function frames(error:Error){Object.defineProperty(error,"toString",{value:()=>"fixed"});const target=new EventTarget();target.addEventListener(error as never,()=>{});return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-ignored-evaluated-tail-data',
    source:
      'function frames(error:Error){const target=new EventTarget();(target.addEventListener as(...args:unknown[])=>void)(error,()=>{},false,Object.defineProperty(error,"toString",{value:()=>"fixed"}));return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-handler-evaluation-data',
    source:
      'function frames(error:Error){const target=new EventTarget();target.addEventListener(error as never,(Object.defineProperty(error,"toString",{value:()=>"fixed"}),()=>{}));return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-computed-member-data',
    source:
      'function frames(error:Error){const target=new EventTarget();target[(Object.defineProperty(error,"toString",{value:()=>"fixed"}),"addEventListener")](error as never,()=>{});return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-local-target-data',
    source:
      'function frames(error:Error){class EventTarget{addEventListener(..._args:unknown[]){}}const target=new EventTarget();target.addEventListener(error,()=>{});return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-replaced-through-alias-data',
    source:
      'function frames(error:Error){const target=new EventTarget();const alias=target;alias.addEventListener=()=>{};target.addEventListener(error as never,()=>{});return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-owner-prior-callback-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();const target=new EventTarget();target.addEventListener(value as never,()=>{});return "fixed";}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-owner-prior-member-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{ready:unknown}){prepare.ready;const target=new EventTarget();target.addEventListener(value as never,()=>{});return "fixed";}return collect(error,{get ready(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return 0;}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-captured-owner-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){const target=new EventTarget();target.addEventListener(value as never,()=>{});return "fixed";}return read();}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-owner-default-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,ignored=(prepare(),0)){const target=new EventTarget();target.addEventListener(value as never,()=>{});return "fixed";}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-handler-factory-prefix-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>EventListener){const handler=prepare();const target=new EventTarget();target.addEventListener(value as never,handler);return "fixed";}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});return ()=>{};});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-previous-dispatch-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const target=new EventTarget();target.addEventListener("fixed",prepare);target.dispatchEvent(new Event("fixed"));target.addEventListener(value as never,()=>{});return "fixed";}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'listener-anonymous-handler-alias',
    source:
      'function frames(error:Error){const target=new EventTarget();const handler=function(){};target.addEventListener("fixed",handler);target.removeEventListener(error as never,handler);return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'listener-directive-safe-prefix',
    source:
      'function frames(error:Error){"use strict";const target=new EventTarget();target.addEventListener(error as never,()=>{},false);return "fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
] as const;

describe('literal method this readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'event-listener.ts', source);
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

describe('literal method this admissions', () => {
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
