import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native Array.from invokes a quiet mapper for every sparse input position. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'sparse-captured-stack',
    source: 'function frames(error:Error){return Array.from([,],()=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-captured-message',
    source: 'function frames(error:Error){return Array.from([,],()=>error)[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-optional-stack',
    source: 'function frames(error:Error){return Array.from([,],()=>error)[0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-fresh-stack',
    source: 'function frames(error:Error){return Array.from([,],()=>new Error("ours"))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-second-position',
    source: 'function frames(error:Error){return Array.from([0,,0],()=>error)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-consecutive-holes',
    source: 'function frames(error:Error){return Array.from([,,],()=>error)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-const-source',
    source:
      'function frames(error:Error){const source=[,];return Array.from(source,()=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-saved-result',
    source:
      'function frames(error:Error){const results=Array.from([,],()=>error);return results[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-function-mapper',
    source:
      'function frames(error:Error){return Array.from([,],function(){return error;})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-const-mapper',
    source:
      'function frames(error:Error){const mapper=()=>error;return Array.from([,],mapper)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-declared-mapper',
    source:
      'function frames(error:Error){function mapper(){return error;}return Array.from([,],mapper)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-native-alias',
    source:
      'function frames(error:Error){const from=Array.from;return from([,],()=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-global-computed',
    source:
      'function frames(error:Error){return globalThis.Array["from"]([,],()=>error)["0"]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-runtime-this-parameter',
    source:
      'function frames(error:Error){return Array.from([,],function(this:void){return error;})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-unused-runtime-input',
    source:
      'function frames(error:Error){return Array.from([,],(_value,_index)=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-finite-argument-spread',
    source:
      'function frames(error:Error){return Array.from(...[[,],()=>error] as const)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'identity-hole-is-undefined',
    source:
      'function frames(error:Error){return Array.from([,error],value=>value)[0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'identity-second-hole-is-undefined',
    source:
      'function frames(error:Error){return Array.from([error,,],value=>value)[1]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'identity-hole-after-data',
    source:
      'function frames(error:Error){return Array.from([{stack:"fixed"},,],value=>value)[1]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'identity-later-error-keeps-offset',
    source: 'function frames(error:Error){return Array.from([,,error],value=>value)[2]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'explicit-undefined-invokes-mapper',
    source: 'function frames(error:Error){return Array.from([undefined],()=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-source-has-no-mapper-result',
    source:
      'function frames(error:Error){return Array.from([] as Error[],()=>error)[0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'trailing-comma-is-not-an-extra-hole',
    source: 'function frames(error:Error){return Array.from([0,],()=>error)[1]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'out-of-range-does-not-invoke-mapper',
    source: 'function frames(error:Error){return Array.from([,],()=>error)[1]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-constant-data-return',
    source: 'function frames(error:Error){return Array.from([,],()=>({stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-fresh-error-own-message',
    source:
      'function frames(error:Error){return Array.from([,],()=>new Error("fixed"))[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-index-mapper-keeps-position',
    source:
      'function frames(error:Error){return String(Array.from([,,],(_value,index)=>index)[1]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-default-repairs-error',
    source:
      'function frames(error:Error){return Array.from([,] as (Error|undefined)[],(value=Object.assign(error,{stack:"fixed"}))=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-second-default-remains-unused',
    source:
      'function frames(error:Error){return String(Array.from([,],(_value,index:number|Error=Object.assign(error,{stack:"fixed"}))=>index)[0]);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-effectful-mapper-repairs-error',
    source:
      'function frames(error:Error){return Array.from([,],()=>{Object.assign(error,{stack:"fixed"});return error;})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-this-argument-repairs-error',
    source:
      'function frames(error:Error){return Array.from([,],()=>error,Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-ignored-tail-repairs-error',
    source:
      'function frames(error:Error){return (Array.from as (...args:unknown[])=>Error[])([,],()=>error,undefined,Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-source-writes-remain-opaque',
    source:
      'function frames(error:Error){const source:(Error|undefined)[]=[,];source[0]=undefined;return Array.from(source,value=>value)[0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-local-array-implementation',
    source:
      'function frames(error:Error){const Array={from(_source:unknown[],_mapper:()=>Error){return [{stack:"fixed"}];}};return Array.from([,],()=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-hole-does-not-invoke-mapper',
    source: 'function frames(error:Error){return [,].map(()=>error)[0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-nonconstructor-tail-pin',
    source:
      'function frames(error:Error){return Array.from([,],()=>error,new (Array.from as unknown as new()=>unknown)())[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-earlier-nonconstructor-pin',
    source:
      'function frames(error:Error){new (Array.from as unknown as new()=>unknown)();return Array.from([,],()=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'sparse-constructible-Error-tail',
    source:
      'function frames(error:Error){return Array.from([,],()=>error,new Error("quiet"))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'sparse-deferred-getter-construction',
    source:
      'function frames(error:Error){return Array.from([,],()=>error,{get ignored(){return new (Array.from as unknown as new()=>unknown)();}})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('sparse Array.from mapper readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-array-from-mappers.ts', source);
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

describe('shared sparse Array.from mapper admissions', () => {
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
