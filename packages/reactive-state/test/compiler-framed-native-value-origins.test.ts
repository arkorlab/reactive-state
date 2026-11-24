import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
const framedNativeValueCases = [
  {
    id: 'valueof-borrowed-stack',
    source:
      'function frames(error:Error){return(Object.prototype.valueOf.call(error)as {stack?:string}).stack;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'valueof-direct-stack',
    source: 'function frames(error:Error){return(error.valueOf()as {stack?:string}).stack;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'valueof-borrowed-words',
    source:
      'function frames(error:Error){return(Object.prototype.valueOf.call(error)as {message:string}).message;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'valueof-reflect-stack',
    source:
      'function frames(error:Error){return(Reflect.apply(Object.prototype.valueOf,error,[])as {stack?:string}).stack;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'valueof-local-words',
    source:
      'function frames(){return(Object.prototype.valueOf.call(new Error("fixed"))as {message:string}).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'valueof-own-method-data',
    source:
      'function frames(){const error=new Error("fixed");error.valueOf=()=>({stack:"fixed"});return(error.valueOf()as{stack:string}).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'valueof-object-shadow',
    source:
      'function frames(error:Error){const Object={prototype:{valueOf:{call(_value:unknown){return{stack:"fixed"};}}}};return Object.prototype.valueOf.call(error).stack;}',
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'valueof-data-method',
    source: 'function frames(){return({valueOf(){return{stack:"fixed"};}}).valueOf().stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'arrayof-selected-error',
    source: 'function frames(error:Error){return Array.of(error)[0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'arrayof-selected-data',
    source:
      'function frames(error:Error){return Array.of<Error|{stack:string}>(error,{stack:"fixed"})[1]!.stack;}',
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'arrayof-relative-error',
    source:
      'function frames(error:Error){return Array.of<Error|{stack:string}>({stack:"fixed"},error).at(-1)!.stack;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'arrayof-unselected-error',
    source:
      'function frames(error:Error){return Array.of<Error|{stack:string}>({stack:"fixed"},error)[0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'arrayfrom-selected-error',
    source: 'function frames(error:Error){return Array.from([error])[0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'arrayfrom-typed-elements',
    source: 'function frames(values:Error[]){return Array.from(values)[0]!.stack;}',
    invocation: 'frames([new Error()])',
    refused: true,
  },
  {
    id: 'arrayfrom-ignored-source-error',
    source:
      'function frames(error:Error){return Array.from([error],()=>({stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'arrayof-local-shadow',
    source:
      'function frames(error:Error){const Array={of(_value:unknown){return[{stack:"fixed"}];}};return Array.of(error)[0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'arrayfrom-local-shadow',
    source:
      'function frames(error:Error){const Array={from(_value:unknown){return[{stack:"fixed"}];}};return Array.from([error])[0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'arrayfrom-local-words',
    source: 'function frames(){return Array.from([new Error("fixed")])[0]!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'arrayof-native-alias',
    source: 'function frames(error:Error){const of=Array.of;return of(error)[0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'arrayfrom-qualified',
    source: 'function frames(error:Error){return globalThis.Array.from([error])[0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'arrayfrom-empty',
    source: 'function frames(){return Array.from([]as Error[])[0]?.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'groupby-selected-error',
    source:
      'function frames(error:Error){return Object.groupBy([error],()=>"failure").failure![0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'groupby-selected-words',
    source:
      'function frames(error:Error){return Object.groupBy([error],()=>"failure").failure![0]!.message;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'groupby-local-words',
    source:
      'function frames(){return Object.groupBy([new Error("fixed")],()=>"failure").failure![0]!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'groupby-excluded-key',
    source:
      'function frames(error:Error){return Object.groupBy([error],():string=>"other").failure?.[0]?.stack;}',
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'groupby-local-shadow',
    source:
      'function frames(error:Error){const Object={groupBy(_source:unknown,_fn:unknown){return{failure:[{stack:"fixed"}]};}};return Object.groupBy([error],()=>"failure").failure[0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'groupby-opaque-callback',
    source:
      'function frames(error:Error,key:string){return Object.groupBy([error],()=>key).failure?.[0]?.stack;}',
    invocation: 'frames(new Error(),"failure")',
    refused: false,
  },
  {
    id: 'groupby-selected-position-data',
    source:
      'function frames(error:Error){return Object.groupBy([{stack:"fixed"},error],()=>"failure").failure![0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: false,
  },
  {
    id: 'groupby-selected-position-error',
    source:
      'function frames(error:Error){return Object.groupBy([{stack:"fixed"},error],()=>"failure").failure![1]!.stack;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'groupby-empty',
    source:
      'function frames(){return Object.groupBy([]as Error[],()=>"failure").failure?.[0]?.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'groupby-constant-key',
    source:
      'function frames(error:Error){const key="failure";return Object.groupBy([error],()=>key).failure![0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'groupby-native-alias',
    source:
      'function frames(error:Error){const group=Object.groupBy;return group([error],()=>"failure").failure![0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: true,
  },
  {
    id: 'arrayfrom-own-iterator-data',
    source:
      'function frames(error:Error){const values=[error];values[Symbol.iterator]=function*(){yield{stack:"fixed"};}as never;return Array.from(values)[0]!.stack;}',
    invocation: 'frames(new Error())',
    refused: false,
  },
] as const;

describe('native value origins', () => {
  const { apps, compile } = compilerApplications();

  it.each(framedNativeValueCases)('$id reader', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-values.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(refused);
  });

  it.each(framedNativeValueCases)('$id actual shared', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((refusal) => refusal.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});

function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
