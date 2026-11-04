import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-written native arguments retain their exact selected element behavior. */
const CASES = [
  {
    id: 'reported-omitted-replacement',
    source:
      'function frames(error:Error){return ([error].with as (index:number,value?:Error)=>Array<Error|undefined>)(0)[0]?.stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'closed-index-tuple-omits-replacement',
    source:
      'function frames(error:Error){return ([error].with as (index:number,value?:Error)=>Array<Error|undefined>)(...([0] as [number]))[0]?.stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-replacement-spread',
    source:
      'function frames(error:Error){return ([error].with as (index:number,value?:Error)=>Array<Error|undefined>)(0,...([] as []))[0]?.stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-call-omits-replacement',
    source:
      'function frames(error:Error){return (Array.prototype.with as (this:Error[],index:number,value?:Error)=>Array<Error|undefined>).call([error],0)[0]?.stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-apply-omits-replacement',
    source:
      'function frames(error:Error){return (Array.prototype.with as (this:Error[],index:number,value?:Error)=>Array<Error|undefined>).apply([error],[0])[0]?.stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflected-omitted-replacement',
    source:
      'function frames(error:Error){return Reflect.apply(Array.prototype.with,[error],[0])[0]?.stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'negative-index-omits-replacement',
    source:
      'function frames(error:Error){return ([error].with as (index:number,value?:Error)=>Array<Error|undefined>)(-1)[0]?.stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'explicit-undefined-keeps-data',
    source:
      'function frames(error:Error){return ([error].with as (index:number,value?:Error)=>Array<Error|undefined>)(0,undefined)[0]?.stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unreplaced-slot-keeps-Error',
    source:
      'function frames(error:Error){return ([error,error].with as (index:number,value?:Error)=>Array<Error|undefined>)(1)[0]?.stack ?? "fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'explicit-Error-replacement-retained',
    source:
      'function frames(error:Error){return ([undefined].with as (index:number,value?:Error)=>Array<Error|undefined>)(0,error)[0]?.stack ?? "fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-rest-keeps-possible-replacement',
    source:
      'function frames(error:Error,args:[number,...Error[]]){return ([error].with as (index:number,value?:Error)=>Array<Error|undefined>)(...args)[0]?.stack ?? "fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"),[0,new Error("ours")])',
  },
  {
    id: 'unknown-index-keeps-source',
    source:
      'function frames(error:Error,index:number){return ([error,error].with as (index:number,value?:Error)=>Array<Error|undefined>)(index)[0]?.stack ?? "fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"),1)',
  },
  {
    id: 'own-with-keeps-Error-result',
    source:
      'function frames(error:Error){const values=[error];values.with=()=>[error];return (values.with as (index:number,value?:Error)=>Array<Error|undefined>)(0)[0]?.stack ?? "fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ordinary-data-remains-data',
    source:
      'function frames(_error:Error){return ([{stack:"fixed"}].with as (index:number,value?:{stack:string})=>Array<{stack:string}|undefined>)(0)[0]?.stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'with-default-source-install',
    source:
      'function frames(error:Error){const values=[error];const {a=(values.with as (index:number,value?:Error)=>Array<Error|undefined>)(0)[0]?.stack ?? "fixed"}=(values.with=()=>[error],{} as {a?:string});return a;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'with-default-source-other',
    source:
      'function frames(error:Error){const values=[error];const other=[0];const {a=(values.with as (index:number,value?:Error)=>Array<Error|undefined>)(0)[0]?.stack ?? "fixed"}=(other.with=()=>[0],{} as {a?:string});return a;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
] as const;

describe('array with omitted replacement readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-encoding-callbacks.ts', source);
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

describe('shared array with omitted replacement text', () => {
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
