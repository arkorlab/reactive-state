import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A native mapper's returned first parameter keeps the written defaults its source slot leaves to apply. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'map-whole-parameter-default-reported',
    source:
      'function frames(error:Error){return[undefined].map((value:Error|undefined=error)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'flat-map-whole-parameter-default',
    source:
      'function frames(error:Error){return[undefined].flatMap((value:Error|undefined=error)=>[value])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-whole-default-present-data',
    source:
      'function frames(error:Error){return[{stack:"fixed"}].map((value:{stack?:string}=error)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-undefined-const-default-error',
    source:
      'function frames(error:Error){const none=undefined;return[none].map((value:Error|undefined=error)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-destructured-default-error',
    source:
      'function frames(error:Error){return[{failure:undefined}].map(({failure=error}:{failure?:Error})=>failure)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-destructured-default-present-data',
    source:
      'function frames(error:Error){return[{failure:{stack:"fixed"}}].map(({failure=error}:{failure?:{stack?:string}})=>failure)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'map-array-pattern-default-error',
    source:
      'function frames(error:Error){return[([undefined]as[Error?])].map(([value=error]:[Error?])=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-object-parameter-default-error',
    source:
      'function frames(error:Error){return[undefined].map(({failure=error}:{failure?:Error}={})=>failure)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'map-default-pure-data',
    source:
      'function frames(error:Error){return[undefined].map((value:{stack:string}={stack:"fixed"})=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'object-missing-default-error',
    source:
      'function frames(error:Error){return[{}].map(({failure=error}:{failure?:Error})=>failure)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-object-missing-default-error',
    source:
      'function frames(error:Error){return[{}].map(({holder:{failure=error}={}}:{holder?:{failure?:Error}})=>failure)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-object-present-data',
    source:
      'function frames(error:Error){return[{holder:{failure:{stack:"fixed"}}}].map(({holder:{failure=error}={}}:{holder?:{failure?:{stack?:string}}})=>failure)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'whole-default-holder-error',
    source:
      'function frames(error:Error){return[undefined].map(({failure}:{failure:Error}={failure:error})=>failure)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-array-default-error',
    source:
      'function frames(error:Error){return[undefined].map(([value]:[Error]=[error])=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'direct-hole-skips-default',
    source:
      'function frames(error:Error){return([,]as undefined[]).map((value:Error|undefined=error)=>value)[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'spread-hole-selects-default',
    source:
      'function frames(error:Error){return[...([,]as undefined[])].map((value:Error|undefined=error)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unrelated-fixed-index-data',
    source:
      'function frames(error:Error){return[{stack:"fixed"},undefined].map((value:{stack?:string}=error)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'fixed-suffix-default-error',
    source:
      'function frames(error:Error){return[{stack:"fixed"},undefined].map((value:{stack?:string}=error)=>value)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-input-constant-default',
    source:
      'function frames(error:Error){const input=[undefined];return input.map((value:Error|undefined=error)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-mapper-constant-default',
    source:
      'function frames(error:Error){const mapping=(value:Error|undefined=error)=>value;return[undefined].map(mapping)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'computed-literal-selected-default',
    source:
      'function frames(error:Error){return[undefined].map((value:Error|undefined=error)=>value)[0]!["stack"];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-borrowed-default',
    source:
      'function frames(error:Error){return(Array.prototype.map.call as(receiver:undefined[],callback:(value:Error|undefined)=>Error)=>Error[])([undefined],(value=error)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-reflect-default',
    source:
      'function frames(error:Error){return(Reflect.apply as(target:unknown,receiver:undefined[],args:unknown[])=>Error[])(Array.prototype.map,[undefined],[(value:Error|undefined=error)=>value])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'new-native-error-default-stack',
    source:
      'function frames(error:Error){return[undefined].map((value:Error|undefined=new Error("ours"))=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'new-native-error-default-message',
    source:
      'function frames(error:Error){return[undefined].map((value:Error|undefined=new Error("ours"))=>value)[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-Array-shadow-keeps-data',
    source:
      'function frames(error:Error){const Array={prototype:{map:{call(_receiver:unknown,_callback:unknown){return[{stack:"fixed"}];}}}};return Array.prototype.map.call([undefined],(value:Error|undefined=error)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'ignored-native-tail-rewrites-default',
    source:
      'function frames(error:Error){return([undefined].map as(...args:unknown[])=>Error[])((value:Error|undefined=error)=>value,undefined,Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'prior-owner-call-rewrites-default',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});return[undefined].map((value:Error|undefined=error)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'callback-prefix-rewrites-default',
    source:
      'function frames(error:Error){return[undefined].map((value:Error|undefined=error)=>{const fixed=Object.assign(value,{stack:"fixed"});return value;})[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'effectful-default-rewrites-error',
    source:
      'function frames(error:Error){return[undefined].map((value:Error|undefined=Object.assign(error,{stack:"fixed"}))=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'saved-result-rewritten-data',
    source:
      'function frames(error:Error){const result=[undefined].map((value:Error|undefined=error)=>value);Object.assign(result[0]!,{stack:"fixed"});return result[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'captured-owner-default-data',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});function read(){return[undefined].map((value:Error|undefined=error)=>value)[0]!.stack;}return read();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'source-getter-rewrites-default',
    source:
      'function frames(error:Error){return[{get failure(){return Object.assign(error,{stack:"fixed"});}}].map(({failure=error}:{failure?:Error})=>failure)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'conditional-source-default',
    source:
      'function frames(error:Error,choose:boolean){return[choose?undefined:{stack:"fixed"}].map((value:{stack?:string}=error)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"),true)',
    refused: true,
  },
  {
    id: 'conditional-present-data-skips-default',
    source:
      'function frames(error:Error,choose:boolean){return[choose?{stack:"fixed"}:{stack:"also fixed"}].map((value:{stack?:string}=error)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"),true)',
    refused: false,
  },
  {
    id: 'native-undefined-void-default',
    source:
      'function frames(error:Error){return[void 0].map((value:Error|undefined=error)=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-array-element-default-error',
    source:
      'function frames(error:Error){return[{holder:([undefined]as[Error?])}].map(({holder:[failure=error]}:{holder:[Error?]})=>failure)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'async-mapper-default-pin',
    source:
      'function frames(error:Error){return([undefined].map(async(value:Error|undefined=error)=>value)[0]as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'null-slot-skips-default-pin',
    source:
      'function frames(error:Error){return([null].map((value:Error|null=error)=>value)[0]as{stack?:string}|null)?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('mapper default parameter readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'mapper-defaults.ts', source);
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

describe('shared mapper default parameter admissions', () => {
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
