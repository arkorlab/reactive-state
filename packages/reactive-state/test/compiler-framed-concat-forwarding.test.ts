import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'concat-spreadable-review-case',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-supplied-words',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-whole-alias',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};const alias=value;return([]as any[]).concat(alias)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-symbol-alias',
    source:
      'const spread=Symbol.isConcatSpreadable;function frames(error:Error){const value={0:error,length:1,[spread]:true};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-written-spread',
    source:
      'function frames(error:Error){const fields={0:error,length:1};const value={...fields,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-getter-slot',
    source:
      'function frames(error:Error){const value={get 0(){return error;},length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-getter-length',
    source:
      'function frames(error:Error){const value={0:error,get length(){return 1;},[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-opaque-length',
    source:
      'function frames(error:Error,length:number=1){const value={0:error,length,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-opaque-flag',
    source:
      'function frames(error:Error,spread:boolean=true){const value={0:error,length:1,[Symbol.isConcatSpreadable]:spread};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-known-prefix',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return([{stack:"fixed"}]as any[]).concat(value)[1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-borrowed',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return Array.prototype.concat.call([],value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-ordinary-data-pin',
    source:
      'function frames(error:Error){const value={0:{stack:"fixed"},length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-local-words-pin',
    source:
      'function frames(error:Error){const value={0:new Error("fixed"),length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-false-pin',
    source:
      'function frames(error:Error){const value={0:error,length:1,stack:"fixed",[Symbol.isConcatSpreadable]:false};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-missing-symbol-pin',
    source:
      'function frames(error:Error){const value={0:error,length:1,stack:"fixed"};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'concat-spreadable-shadow-symbol-pin',
    source:
      'function frames(error:Error){const Symbol={isConcatSpreadable:"spread"};const value={0:error,length:1,stack:"fixed",[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-zero-length-pin',
    source:
      'function frames(error:Error){const value={0:error,length:0,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value,{stack:"fixed"})[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-unselected-slot-pin',
    source:
      'function frames(error:Error){const value={0:{stack:"fixed"},1:error,length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-truthy-error-flag-pin',
    source:
      'function frames(error:Error){const value={0:{stack:"fixed"},length:1,[Symbol.isConcatSpreadable]:error};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-spreadable-later-array-pin',
    source:
      'function frames(error:Error){const value={0:{stack:"fixed"},length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value,[error])[1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-effectful-later-argument-message-pin',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value,Object.assign(value,{0:{message:"fixed",stack:"fixed"}}))[0].message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-effectful-later-argument-stack-pin',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value,Object.assign(value,{0:{message:"fixed",stack:"fixed"}}))[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-quiet-later-argument-sensitivity',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value,0)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-get-hook-rewrites',
    source:
      'function frames(error:Error){const value={0:error,length:1,get [Symbol.isConcatSpreadable](){Object.assign(error,{message:"fixed",name:"Fixed"});return true;}};return ([] as any[]).concat(value)[0].message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-get-length-rewrites',
    source:
      'function frames(error:Error){const value={0:error,get length(){Object.assign(error,{message:"fixed",name:"Fixed"});return 1;},[Symbol.isConcatSpreadable]:true};return ([] as any[]).concat(value)[0].message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-get-slot-rewrites',
    source:
      'function frames(error:Error){const value={get 0(){Object.assign(error,{message:"fixed",name:"Fixed"});return error;},length:1,[Symbol.isConcatSpreadable]:true};return ([] as any[]).concat(value)[0].message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-quiet-hook-getter-sensitivity',
    source:
      'function frames(error:Error){const value={0:error,length:1,get [Symbol.isConcatSpreadable](){return true;}};return([]as any[]).concat(value)[0].stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-undefined-hook-getter-pin',
    source:
      'function frames(error:Error){const value={0:error,length:1,stack:"fixed",get [Symbol.isConcatSpreadable](){return undefined;}};return([]as any[]).concat(value)[0].stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-zero-length-getter-pin',
    source:
      'function frames(error:Error){const value={0:error,get length(){return 0;},[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value,{stack:"fixed"})[0].stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-undefined-length-data-pin',
    source:
      'function frames(error:Error){const value={0:error,length:undefined,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value,{stack:"fixed"})[0].stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-void-length-data-pin',
    source:
      'function frames(error:Error){const value={0:error,length:void 0,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value,{stack:"fixed"})[0].stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-length-coercion-rewrites-pin',
    source:
      'function frames(error:Error){const length={valueOf(){Object.assign(error,{message:"fixed",name:"Fixed"});return 1;}};const value={0:error,length,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-earlier-slot-getter-rewrites-pin',
    source:
      'function frames(error:Error){const value={get 0(){Object.assign(error,{message:"fixed",name:"Fixed"});return {message:"fixed"};},1:error,length:2,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[1].message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-earlier-slot-getter-quiet-sensitivity',
    source:
      'function frames(error:Error){const value={get 0(){return {message:"fixed"};},1:error,length:2,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[1].stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-uninvoked-extra-getter-sensitivity',
    source:
      'function frames(error:Error){const value={0:error,length:1,get extra(){Object.assign(error,{message:"fixed",name:"Fixed"});return 0;},[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-initializer-rewrites-pin',
    source:
      'function frames(error:Error){const value={0:error,extra:Object.assign(error,{message:"fixed",name:"Fixed"}),length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-computed-key-rewrites-pin',
    source:
      'function frames(error:Error){const value={0:error,[(Object.assign(error,{message:"fixed",name:"Fixed"}),"extra")]:0,length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-spread-getter-rewrites-pin',
    source:
      'function frames(error:Error){const fields={get extra(){Object.assign(error,{message:"fixed",name:"Fixed"});return 0;}};const value={...fields,0:error,length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-spread-slot-getter-sensitivity',
    source:
      'function frames(error:Error){const fields={get 0(){return error;}};const value={...fields,length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-setter-only-hook-pin',
    source:
      'function frames(error:Error){const value={0:error,length:1,stack:"fixed",set [Symbol.isConcatSpreadable](_flag:boolean){}};return([]as any[]).concat(value)[0].stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-reflect-ignored-tail-pin',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return(Reflect.apply as(...args:unknown[])=>any[])(Array.prototype.concat,[],[value],Object.assign(error,{message:"fixed",stack:"fixed"}))[0].message;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-apply-ignored-tail-pin',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return(Array.prototype.concat.apply as(...args:unknown[])=>any[])([],[value],Object.assign(error,{message:"fixed",stack:"fixed"}))[0].message;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-receiver-creation-rewrites-pin',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return Array.prototype.concat.call([Object.assign(error,{message:"fixed",stack:"fixed"})]as any[],value)[1].message;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-prior-written-stack-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-reflect-ignored-tail-quiet-sensitivity',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return(Reflect.apply as(...args:unknown[])=>any[])(Array.prototype.concat,[],[value],0)[0].message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-apply-ignored-tail-quiet-sensitivity',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return(Array.prototype.concat.apply as(...args:unknown[])=>any[])([],[value],0)[0].message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-receiver-creation-rewrites-quiet-sensitivity',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};return Array.prototype.concat.call([{message:"fixed",stack:"fixed"}]as any[],value)[1].message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'concat-carried-whole-value-alias',
    source:
      'function frames(error:Error){const item=error;const value={0:item,length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-after-source-written-stack-pin',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};Object.defineProperty(error,"stack",{value:"fixed"});return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-carried-member-alias-prior-stack-pin',
    source:
      'function frames(box:{failure:Error}){Object.defineProperty(box.failure,"stack",{value:"fixed"});const item=box.failure;const value={0:item,length:1,[Symbol.isConcatSpreadable]:true};return([]as any[]).concat(value)[0].stack;}',
    invocation: 'frames({failure:new Error("ours")})',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-loop-condition-use',
    source:
      'function frames(error:Error){const value={0:error,length:1,[Symbol.isConcatSpreadable]:true};let result:unknown;let i=0;do{result=([]as any[]).concat(value)[0].stack;}while((void value,i++<1));return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'concat-loop-condition-data',
    source:
      'function frames(error:Error){const value={0:{stack:"fixed"},length:1,[Symbol.isConcatSpreadable]:true};let result:unknown;let i=0;do{result=([]as any[]).concat(value)[0].stack;}while((void value,i++<1));return result;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native concat forwarding words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'concat-forwarding.ts', source);
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

describe('shared concat forwarding admission', () => {
  let api: API;
  const apps: Application[] = [];
  const observations: unknown[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    const file = process.env['RECOVERY_FORWARDING_OBSERVATIONS'];
    if (file !== undefined) writeFileSync(file, JSON.stringify(observations, null, 2));
    api[Symbol.dispose]();
    await Promise.all(apps.map(async (app) => removed(app)));
  });

  it.each(CASES)('$id', async ({ id, source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compiledApp(app, api).refusals.map((item) => item.reason);
    observations.push({ id, source, expectedRefused: refused, reasons });
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
