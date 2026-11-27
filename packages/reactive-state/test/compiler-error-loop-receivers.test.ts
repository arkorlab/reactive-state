import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Repeated loop error receivers retain their written error observations. */
const CASES = [
  {
    id: 'counted-loop-later-error',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(let i=0;i<2;i++){result=value.stack;value=new Error("ours");}return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'while-loop-later-error',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;let i=0;while(i++<2){result=value.stack;value=new Error("ours");}return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'do-loop-later-error',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;let i=0;do{result=value.stack;value=new Error("ours");}while(i++<1);return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'for-of-later-error',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(const _entry of [0,1]){result=value.stack;value=new Error("ours");}return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'outer-loop-later-error',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(let i=0;i<2;i++){for(let j=0;j<1;j++){result=value.stack;}value=new Error("ours");}return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'do-condition-later-error',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;let i=0;do{result=value.stack;}while((value=new Error("ours"),i++<1));return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'for-update-later-error',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(let i=0;(result=value.stack,i<2);i++,value=new Error("ours")){}return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'while-condition-order-error',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;let i=0;while((result=value.stack)!==undefined&&(value=new Error("ours"))&&i++<1){}return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'for-condition-order-error',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(let i=0;(result=value.stack,value=new Error("ours"),i<2);i++){}return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'for-of-binding-order-error',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(const {a=value.stack,b=(value=new Error("ours"))} of [{},{}] as {a?:string;b?:unknown}[]){result=a;void b;}return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'fresh-iteration-data',
    source:
      'function frames(){let result;for(let i=0;i<2;i++){let value:{stack?:string}={stack:"fixed"};result=value.stack;value=new Error("ours");}return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'single-do-iteration-data',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;do{result=value.stack;value=new Error("ours");}while(false);return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'write-after-loop-data',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(let i=0;i<2;i++){result=value.stack;}value=new Error("ours");return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'unselected-loop-write-data',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(let i=0;i<2;i++){result=value.stack;if(false)value=new Error("ours");}return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'loop-shadow-data',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(let i=0;i<2;i++){result=value.stack;{let value:{stack?:string}={stack:"other"};value=new Error("ours");}}return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'ordinary-next-iteration-data',
    source:
      'function frames(){let value={stack:"fixed"};let result;for(let i=0;i<2;i++){result=value.stack;value={stack:"other"};}return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'fresh-var-iteration-data',
    source:
      'function frames(){let result;for(let i=0;i<2;i++){var value:{stack?:string}={stack:"fixed"};result=value.stack;value=new Error("ours");}return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'single-for-of-iteration-data',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(const _entry of [0]){result=value.stack;value=new Error("ours");}return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'fresh-var-condition-data',
    source:
      'function frames(){let result;let i=0;do{var value:{stack?:string}={stack:"fixed"};result=value.stack;}while((value=new Error("ours"),i++<1));return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'for-initializer-once-data',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(let i=(result=value.stack,0),j=(value=new Error("ours"));i<2;i++){void j;}return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'for-of-iterable-once-data',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(const _entry of [(result=value.stack),(value=new Error("ours"))]){}return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'for-in-iterable-once-data',
    source:
      'function frames(){let value:{stack?:string}={stack:"fixed"};let result;for(const _key in {a:(result=value.stack),b:(value=new Error("ours"))}){}return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'create-spread-condition-error',
    source:
      'function frames(){const args:[object]=[{stack:"fixed"}];let result:unknown;let i=0;do{result=Object.create(...args).stack;}while((args[0]=new Error("ours"),i++<1));return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'create-spread-condition-data',
    source:
      'function frames(){const args:[object]=[{stack:"fixed"}];let result:unknown;let i=0;do{result=Object.create(...args).stack;}while((args[0]={stack:"later"},i++<1));return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'construct-spread-condition-error',
    source:
      'function frames(){class Fixed{stack="fixed";}const args:[new()=>object,[]]=[Fixed,[]];let result:unknown;let i=0;do{result=(Reflect.construct(...args) as {stack?:string}).stack;}while((args[0]=Error,i++<1));return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'construct-spread-condition-data',
    source:
      'function frames(){class Fixed{stack="fixed";}class Later{stack="later";}const args:[new()=>object,[]]=[Fixed,[]];let result:unknown;let i=0;do{result=(Reflect.construct(...args) as {stack?:string}).stack;}while((args[0]=Later,i++<1));return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'create-spread-update-error',
    source:
      'function frames(){const args:[object]=[{stack:"fixed"}];let result:unknown;for(let i=0;(result=Object.create(...args).stack,i<2);i++,args[0]=new Error("ours")){}return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'create-spread-update-data',
    source:
      'function frames(){const args:[object]=[{stack:"fixed"}];let result:unknown;for(let i=0;(result=Object.create(...args).stack,i<2);i++,args[0]={stack:"later"}){}return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'construct-spread-update-error',
    source:
      'function frames(){class Fixed{stack="fixed";}const args:[new()=>object,[]]=[Fixed,[]];let result:unknown;for(let i=0;(result=(Reflect.construct(...args) as {stack?:string}).stack,i<2);i++,args[0]=Error){}return result;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'construct-spread-update-data',
    source:
      'function frames(){class Fixed{stack="fixed";}class Later{stack="later";}const args:[new()=>object,[]]=[Fixed,[]];let result:unknown;for(let i=0;(result=(Reflect.construct(...args) as {stack?:string}).stack,i<2);i++,args[0]=Later){}return result;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
] as const;

describe('repeated loop error receiver readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'bounded-error-observation.ts', source);
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

describe('repeated loop error receiver shared admission', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, sharedRefused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const sharedReason = expect.stringContaining('a shared module that answers otherwise');
    const expected = sharedRefused ? [sharedReason] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
