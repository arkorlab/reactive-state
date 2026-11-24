import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'reported-map-spread-callback',
    source: 'function frames(error:Error){return[0].map(...([()=>error]as const))[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flatmap-spread-callback',
    source:
      'function frames(error:Error){return[0].flatMap(...([()=>[error]]as const))[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-spread-before-callback',
    source: 'function frames(error:Error){return[0].map(...([]as const),()=>error)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'tuple-alias-callback',
    source:
      'function frames(error:Error){const args=[()=>error]as const;return[0].map(...args)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'callback-alias-in-spread',
    source:
      'function frames(error:Error){const callback=()=>error;return[0].map(...([callback]as const))[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-spread-callback',
    source:
      'function frames(error:Error){return[0].map(...([...([()=>error]as const)]as const))[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-map-borrowed-spread',
    source:
      'function frames(error:Error){return(Array.prototype.map.call as(receiver:number[],callback:()=>Error)=>Error[])([0],...([()=>error]as const))[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-flatmap-borrowed-spread',
    source:
      'function frames(error:Error){return(Array.prototype.flatMap.call as(receiver:number[],callback:()=>Error[])=>Error[])([0],...([()=>[error]]as const))[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-map-applied-spread',
    source:
      'function frames(error:Error){return(Array.prototype.map.apply as(receiver:number[],args:readonly unknown[])=>Error[])([0],[...([()=>error]as const)])[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-flatmap-reflected-spread',
    source:
      'function frames(error:Error){return(Reflect.apply as(target:unknown,receiver:number[],args:readonly unknown[])=>Error[])(Array.prototype.flatMap,[0],[...([()=>[error]]as const)])[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-map-empty-input',
    source:
      'function frames(error:Error){return([]as number[]).map(...([()=>error]as const))[0]?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-map-input-hole',
    source:
      'function frames(error:Error){return([,]as undefined[]).map(...([()=>error]as const))[0]?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-flatmap-input-hole',
    source:
      'function frames(error:Error){return([,]as undefined[]).flatMap(...([()=>[error]]as const))[0]?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'map-known-selected-data',
    source:
      'function frames(error:Error){return[{stack:"fixed"},error].map(...([(value:{stack?:string})=>value]as const))[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'map-known-selected-error',
    source:
      'function frames(error:Error){return[{stack:"fixed"},error].map(...([(value:{stack?:string})=>value]as const))[1]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'map-known-output-excluded',
    source: 'function frames(error:Error){return[0].map(...([()=>error]as const))[1]?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flatmap-empty-output',
    source:
      'function frames(error:Error){return[0].flatMap(...([()=>[]as Error[]]as const))[0]?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-map-local-error-words',
    source:
      'function frames(error:Error){return[0].map(...([()=>new Error("ours")]as const))[0]!.message;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-flatmap-local-error-stack',
    source:
      'function frames(error:Error){return[0].flatMap(...([()=>[new Error("ours")]]as const))[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-tail-stack-replacement',
    source:
      'function frames(error:Error){return([0].map as(...args:unknown[])=>Error[])(...([()=>error,undefined,Object.assign(error,{stack:"fixed"})]as const))[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-ignored-tail-replacement',
    source:
      'function frames(error:Error){return(Array.prototype.map.call as(...args:unknown[])=>Error[])([0],...([()=>error,undefined,Object.assign(error,{stack:"fixed"})]as const))[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'effectful-thisarg-replacement',
    source:
      'function frames(error:Error){return[0].map(...([()=>error,Object.assign(error,{stack:"fixed"})]as const))[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'callback-prefix-stack-replacement',
    source:
      'function frames(error:Error){return[0].map(...([()=>{const changed=Object.assign(error,{stack:"fixed"});return error;}]as const))[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'owner-prefix-stack-replacement',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});return[0].map(...([()=>error]as const))[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-selected-stack-replacement',
    source:
      'function frames(error:Error){return[0].map(...([()=>error]as const))[(Object.assign(error,{stack:"fixed"}),0)]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'saved-result-stack-replacement',
    source:
      'function frames(error:Error){const values=[0].map(...([()=>error]as const));Object.assign(values[0]!,{stack:"fixed"});return values[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'captured-prepare-stack-replacement',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return[0].map(...([()=>value]as const))[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'callback-quiet-const-forward',
    source:
      'function frames(error:Error){return[0].map(...([()=>{const value=error;return value;}]as const))[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-map-keeps-data',
    source:
      'function frames(error:Error){const values=[0];values.map=()=>[{stack:"fixed"}]as never;return values.map(...([()=>error]as const))[0]!.stack;}',
    reader: false,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-array-native-name-keeps-data',
    source:
      'function frames(error:Error){const Array={prototype:{map:{call(_receiver:unknown,..._args:unknown[]){return[{stack:"fixed"}];}}}};return Array.prototype.map.call([0],...([()=>error]as const))[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('mapper argument spread readers', () => {
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

describe('mapper argument spread shared', () => {
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
