import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'flat-default-scalar-reported',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:Error|undefined=error)=>value)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flat-replacement-scalar',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].flatMap((value:Error|{stack:string})=>{const ignored=(value=error);return value;})[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flat-default-present-data',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].flatMap((value:{stack?:string}=error)=>value)[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'flat-existing-array-identity',
    source: 'function frames(error:Error){return[[error]].flatMap(value=>value)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'multi-scalar-default-error',
    source:
      'function frames(error:Error){return[undefined,{stack:"fixed"}].flatMap((value:{stack?:string}=error)=>value)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'multi-scalar-selected-data',
    source:
      'function frames(error:Error){return[undefined,{stack:"fixed"}].flatMap((value:{stack?:string}=error)=>value)[1]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'default-array-element-error',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:Error[]|undefined=[error])=>value)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'scalar-default-output-excluded',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:Error|undefined=error)=>value)[1]?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'undefined-input-alias',
    source:
      'function frames(error:Error){const none=undefined;return[none].flatMap((value:Error|undefined=error)=>value)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-input-alias',
    source:
      'function frames(error:Error){const values=[undefined];return values.flatMap((value:Error|undefined=error)=>value)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-callback-alias',
    source:
      'function frames(error:Error){const callback=(value:Error|undefined=error)=>value;return[undefined].flatMap(callback)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'hole-before-only-input',
    source:
      'function frames(error:Error){return([,undefined]as undefined[]).flatMap((value:Error|undefined=error)=>value)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-holes-skip-replacement',
    source:
      'function frames(error:Error){return([,]as undefined[]).flatMap((value:Error|undefined=error)=>{const ignored=(value=error);return value;})[0]?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'multi-prefix-selected-data',
    source:
      'function frames(error:Error){return[{stack:"fixed"},undefined].flatMap((value:{stack?:string}=error)=>value)[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'multi-suffix-default-error',
    source:
      'function frames(error:Error){return[{stack:"fixed"},undefined].flatMap((value:{stack?:string}=error)=>value)[1]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'multi-scalar-replacement',
    source:
      'function frames(error:Error){return[{stack:"fixed"},{stack:"also fixed"}].flatMap((value:Error|{stack:string})=>{const ignored=(value=error);return value;})[1]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'replacement-output-excluded',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].flatMap((value:Error|{stack:string})=>{const ignored=(value=error);return value;})[1]?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'array-default-selected-data',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{stack?:string}[]|undefined=[{stack:"fixed"},error])=>value)[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'array-default-selected-error',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{stack?:string}[]|undefined=[{stack:"fixed"},error])=>value)[1]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'array-replacement-error',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].flatMap((value:{stack?:string}|{stack?:string}[])=>{const ignored=(value=[error]);return value;})[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-array-default-data',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:{stack?:string}[]|undefined=[])=>value)[0]?.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-borrowed-default',
    source:
      'function frames(error:Error){return(Array.prototype.flatMap.call as(receiver:undefined[],callback:(value:Error|undefined)=>Error)=>Error[])([undefined],(value=error)=>value)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-reflect-default',
    source:
      'function frames(error:Error){return(Reflect.apply as(target:unknown,receiver:undefined[],args:unknown[])=>Error[])(Array.prototype.flatMap,[undefined],[(value:Error|undefined=error)=>value])[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-tail-stack-rewrite',
    source:
      'function frames(error:Error){return([undefined].flatMap as(...args:unknown[])=>Error[])((value:Error|undefined=error)=>value,undefined,Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'callback-prefix-stack-rewrite',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:Error|undefined=error)=>{const changed=Object.assign(value,{stack:"fixed"});return value;})[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'prior-owner-stack-rewrite',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});return[undefined].flatMap((value:Error|undefined=error)=>value)[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-selection-rewrite',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:Error|undefined=error)=>value)[(Object.assign(error,{stack:"fixed"}),0)]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'saved-result-stack-rewrite',
    source:
      'function frames(error:Error){const values=[undefined].flatMap((value:Error|undefined=error)=>value);Object.assign(values[0]!,{stack:"fixed"});return values[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'captured-owner-data',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});function read(){return[undefined].flatMap((value:Error|undefined=error)=>value)[0]!.stack;}return read();}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-flatmap-keeps-data',
    source:
      'function frames(error:Error){const values=[error];values.flatMap=()=>[{stack:"fixed"}]as never;return values.flatMap((value:Error)=>value)[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-native-name-data',
    source:
      'function frames(error:Error){const Array={prototype:{flatMap:{call(_input:unknown,_callback:unknown){return[{stack:"fixed"}];}}}};return Array.prototype.flatMap.call([undefined],(value:Error|undefined=error)=>value)[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-default-local-words',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:Error|undefined=new Error("ours"))=>value)[0]!.message;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-default-local-stack',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:Error|undefined=new Error("ours"))=>value)[0]!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'effectful-default-not-executed',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].flatMap((value:{stack?:string}=Object.assign(error,{stack:"unused"}))=>value)[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'array-input-prefix-data',
    source:
      'function frames(error:Error){return[[{stack:"fixed"}],undefined].flatMap((value:{stack?:string}|{stack?:string}[]=error)=>value)[0]!.stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-array-flattens-once',
    source:
      'function frames(error:Error){return([undefined].flatMap((value:Error[][]|undefined=[[error]])=>value)[0]as unknown as{stack?:string}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('scalar identity flatMap readers', () => {
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

describe('scalar identity flatMap shared', () => {
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
