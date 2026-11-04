import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'reported-map-input-member',
    source:
      'function frames(error:Error){return([{failure:error}].map((value:{failure:unknown})=>value.failure)[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'literal-computed-input-member',
    source:
      'function frames(error:Error){return([{failure:error}].map((value:{failure:unknown})=>value["failure"])[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-literal-input-members',
    source:
      'function frames(error:Error){return([{box:{failure:error}}].map((value:{box:{failure:unknown}})=>value.box.failure)[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'shorthand-input-field',
    source:
      'function frames(error:Error){const failure=error;return([{failure}].map((value:{failure:unknown})=>value.failure)[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-input-const-alias',
    source:
      'function frames(error:Error){const values=[{failure:error}];return(values.map((value:{failure:unknown})=>value.failure)[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'callback-input-const-alias',
    source:
      'function frames(error:Error){return([{failure:error}].map((value:{failure:unknown})=>{const held=value;return held.failure;})[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'callback-result-const-alias',
    source:
      'function frames(error:Error){return([{failure:error}].map((value:{failure:unknown})=>{const selected=value.failure;return selected;})[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-callback-const-alias',
    source:
      'function frames(error:Error){const mapper=(value:{failure:unknown})=>value.failure;return([{failure:error}].map(mapper)[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-native-map-member',
    source:
      'function frames(error:Error){return((Array.prototype.map.call as(receiver:{failure:unknown}[],callback:(value:{failure:unknown})=>unknown)=>unknown[])([{failure:error}],(value:{failure:unknown})=>value.failure)[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'applied-native-map-member',
    source:
      'function frames(error:Error){return((Array.prototype.map.apply as(receiver:{failure:unknown}[],args:readonly unknown[])=>unknown[])([{failure:error}],[(value:{failure:unknown})=>value.failure])[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflected-native-map-member',
    source:
      'function frames(error:Error){return((Reflect.apply as(target:unknown,receiver:{failure:unknown}[],args:readonly unknown[])=>unknown[])(Array.prototype.map,[{failure:error}],[(value:{failure:unknown})=>value.failure])[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'literal-array-input-member',
    source:
      'function frames(error:Error){return([[error]].map((value:readonly unknown[])=>value[0])[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'readonly-tuple-input-member',
    source:
      'function frames(error:Error){return([[error]as const].map((value:readonly[unknown])=>value[0])[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'selected-data-first',
    source:
      'function frames(error:Error){return([{failure:{stack:"fixed"}},{failure:error}].map((value:{failure:unknown})=>value.failure)[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'selected-error-second',
    source:
      'function frames(error:Error){return([{failure:{stack:"fixed"}},{failure:error}].map((value:{failure:unknown})=>value.failure)[1]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'excluded-output-position',
    source:
      'function frames(error:Error){return([{failure:error}].map((value:{failure:unknown})=>value.failure)[1]as{stack?:string}|undefined)?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-input-hole-skips',
    source:
      'function frames(error:Error){return(([ , ]as({failure:unknown}|undefined)[]).map((value:{failure:unknown}|undefined)=>value?.failure)[0]as{stack?:string}|undefined)?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-empty-input-skips',
    source:
      'function frames(error:Error){return(([]as{failure:unknown}[]).map((value:{failure:unknown})=>value.failure)[0]as{stack?:string}|undefined)?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'literal-field-data',
    source:
      'function frames(error:Error){return([{failure:{stack:"fixed"}}].map((value:{failure:unknown})=>value.failure)[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'field-getter-rewrites-stack',
    source:
      'function frames(error:Error){return([{get failure(){Object.assign(error,{stack:"fixed"});return error;}}].map((value:{failure:unknown})=>value.failure)[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'callback-prefix-rewrites-stack',
    source:
      'function frames(error:Error){return([{failure:error}].map((value:{failure:unknown})=>{const changed=Object.assign(error,{stack:"fixed"});return value.failure;})[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-tail-rewrites-stack',
    source:
      'function frames(error:Error){return(([{failure:error}].map as(...args:unknown[])=>unknown[])((value:{failure:unknown})=>value.failure,undefined,Object.assign(error,{stack:"fixed"}))[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'thisarg-rewrites-stack',
    source:
      'function frames(error:Error){return([{failure:error}].map((value:{failure:unknown})=>value.failure,Object.assign(error,{stack:"fixed"}))[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'owner-prefix-rewrites-stack',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});return([{failure:error}].map((value:{failure:unknown})=>value.failure)[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-index-rewrites-stack',
    source:
      'function frames(error:Error){return([{failure:error}].map((value:{failure:unknown})=>value.failure)[(Object.assign(error,{stack:"fixed"}),0)]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'saved-result-rewrites-stack',
    source:
      'function frames(error:Error){const values=[{failure:error}].map((value:{failure:unknown})=>value.failure);Object.assign(values[0]as Error,{stack:"fixed"});return(values[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'captured-prepare-rewrites-stack',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return([{failure:value}].map((input:{failure:unknown})=>input.failure)[0]as{stack?:string}).stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'parameter-replacement-keeps-data',
    source:
      'function frames(error:Error){return([{failure:error}].map((value:{failure:unknown})=>{const changed=(value={failure:{stack:"fixed"}});return value.failure;})[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'source-descriptor-keeps-data',
    source:
      'function frames(error:Error){const values=[{failure:error}];Object.defineProperty(values[0],"failure",{value:{stack:"fixed"}});return(values.map((value:{failure:unknown})=>value.failure)[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-array-native-shadow',
    source:
      'function frames(error:Error){const Array={prototype:{map:{call(_receiver:unknown,_callback:unknown){return[{stack:"fixed"}];}}}};return Array.prototype.map.call([{failure:error}],(value:{failure:unknown})=>value.failure)[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-map-keeps-data',
    source:
      'function frames(error:Error){const values=[{failure:error}];values.map=()=>[{stack:"fixed"}]as never;return(values.map((value:{failure:unknown})=>value.failure)[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fresh-error-field-stack',
    source:
      'function frames(error:Error){return([{failure:new Error("ours")}].map((value:{failure:unknown})=>value.failure)[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fresh-error-field-local-words',
    source:
      'function frames(error:Error){return([{failure:new Error("ours")}].map((value:{failure:unknown})=>value.failure)[0]as{message?:string}).message;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'optional-nonnull-input-member',
    source:
      'function frames(error:Error){return([{failure:error}].map((value:{failure:unknown})=>value?.failure)[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'destructured-input-member',
    source:
      'function frames(error:Error){return([{box:{failure:error}}].map(({box}:{box:{failure:unknown}})=>box.failure)[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'runtime-leading-this-parameter',
    source:
      'function frames(error:Error){return([{failure:error}].map(function(this:void,value:{failure:unknown}){return value.failure;})[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-return-key-rewrites-stack',
    source:
      'function frames(error:Error){return([{failure:error}].map((value:{failure:unknown})=>value[(Object.assign(error,{stack:"fixed"}),"failure")])[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-field-getter-keeps-data',
    source:
      'function frames(error:Error){return([{box:{get failure(){Object.assign(error,{stack:"fixed"});return error;}}}].map((value:{box:{failure:unknown}})=>value.box.failure)[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flatmap-literal-return-member',
    source:
      'function frames(error:Error){return([{failure:error}].flatMap((value:{failure:unknown})=>[value.failure])[0]as{stack?:string}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flatmap-literal-return-data',
    source:
      'function frames(error:Error){return([{failure:{stack:"fixed"}}].flatMap((value:{failure:unknown})=>[value.failure])[0]as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('mapper input member readers', () => {
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

describe('mapper input member shared', () => {
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
