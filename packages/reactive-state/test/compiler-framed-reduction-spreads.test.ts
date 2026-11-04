import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'reduce-spread-reported',
    source:
      'function frames(error:Error){return([{stack:"fixed"}]as{stack?:string}[]).reduce(...([(acc:{stack?:string})=>error,{stack:"fixed"}]as const)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'right-spread-callback-error',
    source:
      'function frames(error:Error){return([{stack:"fixed"}]as{stack?:string}[]).reduceRight(...([(acc:{stack?:string})=>error,{stack:"fixed"}]as const)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reduce-empty-spread-initial-error',
    source:
      'function frames(error:Error){return([]as{stack?:string}[]).reduce(...([(acc:{stack?:string})=>acc,error]as const)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reduce-spread-callback-data',
    source:
      'function frames(error:Error){return([error]as{stack?:string}[]).reduce(...([(acc:{stack?:string})=>({stack:"fixed"}),{stack:"start"}]as const)).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reduce-spread-no-initial-sole-data',
    source:
      'function frames(error:Error){return([{stack:"fixed"}]as{stack?:string}[]).reduce(...([(acc:{stack?:string})=>error]as const)).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reduce-known-tuple-alias',
    source:
      'function frames(error:Error){const args=[(acc:{stack?:string})=>error,{stack:"fixed"}]as const;return([{stack:"fixed"}]as{stack?:string}[]).reduce(...args).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reduce-fixed-before-unknown',
    source:
      'function frames(error:Error){const extras:unknown[]=[];return([{stack:"fixed"}].reduce as(...args:unknown[])=>{stack?:string})(()=>error,{stack:"fixed"},...extras).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reduce-unknown-prefix-opacity',
    source:
      'function frames(error:Error){const args:unknown[]=[()=>({stack:"fixed"}),{stack:"fixed"}];return([{stack:"fixed"}].reduce as(...args:unknown[])=>{stack?:string})(...args).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-tail-data',
    source:
      'function frames(error:Error){return([{stack:"fixed"}].reduce as(...args:unknown[])=>{stack?:string})(...([()=>error,{stack:"fixed"}]as const),Object.assign(error,{stack:"fixed"})).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'callback-prefix-data',
    source:
      'function frames(error:Error){return([{stack:"fixed"}]as{stack?:string}[]).reduce(...([(_acc:{stack?:string})=>{const fixed=Object.assign(error,{stack:"fixed"});return error;},{stack:"fixed"}]as const)).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'captured-prefix-bridge',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return([{stack:"fixed"}]as{stack?:string}[]).reduce(...([(_acc:{stack?:string})=>value,{stack:"fixed"}]as const)).stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'zero-parameter-result-error',
    source:
      'function frames(error:Error){return([{stack:"fixed"}]as{stack?:string}[]).reduce(...([()=>error,{stack:"fixed"}]as const)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-call-spread',
    source:
      'function frames(error:Error){return(Array.prototype.reduce.call as(receiver:{stack?:string}[],...args:readonly[(acc:{stack?:string})=>{stack?:string},{stack?:string}])=>{stack?:string})([{stack:"fixed"}],...([(acc:{stack?:string})=>error,{stack:"fixed"}]as const)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-apply-spread',
    source:
      'function frames(error:Error){return(Array.prototype.reduce.apply as(receiver:{stack?:string}[],args:readonly[(acc:{stack?:string})=>{stack?:string},{stack?:string}])=>{stack?:string})([{stack:"fixed"}],[...([(acc:{stack?:string})=>error,{stack:"fixed"}]as const)]).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflect-apply-spread',
    source:
      'function frames(error:Error){return(Reflect.apply as(target:unknown,receiver:{stack?:string}[],args:readonly[(acc:{stack?:string})=>{stack?:string},{stack?:string}])=>{stack?:string})(Array.prototype.reduce,[{stack:"fixed"}],[...([(acc:{stack?:string})=>error,{stack:"fixed"}]as const)]).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'right-borrowed-spread',
    source:
      'function frames(error:Error){return(Array.prototype.reduceRight.call as(receiver:{stack?:string}[],...args:readonly[(acc:{stack?:string})=>{stack?:string},{stack?:string}])=>{stack?:string})([{stack:"fixed"}],...([(acc:{stack?:string})=>error,{stack:"fixed"}]as const)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'split-initial-spread',
    source:
      'function frames(error:Error){return([{stack:"fixed"}]as{stack?:string}[]).reduce((acc:{stack?:string})=>error,...([{stack:"fixed"}]as const)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-literal-spread',
    source:
      'function frames(error:Error){return([{stack:"fixed"}]as{stack?:string}[]).reduce(...([...([(acc:{stack?:string})=>error,{stack:"fixed"}]as const)]as const)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-leading-spread',
    source:
      'function frames(error:Error){return([{stack:"fixed"}].reduce as(...args:unknown[])=>{stack?:string})(...([]as const),(acc:{stack?:string})=>error,{stack:"fixed"}).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-input-skips-callback',
    source:
      'function frames(error:Error){return([]as{stack?:string}[]).reduce(...([(acc:{stack?:string})=>error,{stack:"fixed"}]as const)).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'explicit-undefined-default',
    source:
      'function frames(error:Error){return([{stack:"fixed"}]as{stack?:string}[]).reduce(...([(acc:{stack?:string}|undefined=error)=>acc,undefined]as const))!.stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'known-present-skips-default',
    source:
      'function frames(error:Error){return([{stack:"fixed"}]as{stack?:string}[]).reduce(...([(acc:{stack?:string}=error)=>acc,{stack:"fixed"}]as const)).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fresh-error-initial-frames',
    source:
      'function frames(error:Error){return([]as Error[]).reduce(...([(acc:Error)=>acc,new Error("ours")]as const)).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fresh-error-initial-words',
    source:
      'function frames(error:Error){return([]as Error[]).reduce(...([(acc:Error)=>acc,new Error("ours")]as const)).message;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-reduce-keeps-data',
    source:
      'function frames(error:Error){const values=[error];values.reduce=()=>({stack:"fixed"}as never);return values.reduce(...([(acc:Error)=>error,error]as const)).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-before-native-slots',
    source:
      'function frames(error:Error){const extras:unknown[]=[];return([{stack:"fixed"}].reduce as(...args:unknown[])=>{stack?:string})(...extras,()=>({stack:"fixed"}),{stack:"fixed"}).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'tuple-callback-replaced-data',
    source:
      'function frames(error:Error){const args:[(acc:{stack?:string})=>{stack?:string},{stack?:string}]=[()=>error,{stack:"fixed"}];args[0]=()=>({stack:"fixed"});return([{stack:"fixed"}]as{stack?:string}[]).reduce(...args).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflect-ignored-tail-data',
    source:
      'function frames(error:Error){return(Reflect.apply as(...args:unknown[])=>{stack?:string})(Array.prototype.reduce,[{stack:"fixed"}],[...([()=>error,{stack:"fixed"}]as const)],Object.assign(error,{stack:"fixed"})).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'apply-ignored-tail-data',
    source:
      'function frames(error:Error){return(Array.prototype.reduce.apply as(...args:unknown[])=>{stack?:string})([{stack:"fixed"}],[...([()=>error,{stack:"fixed"}]as const)],Object.assign(error,{stack:"fixed"})).stack;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'captured-owner-rewrite-data',
    source:
      'function frames(error:Error){Object.assign(error,{stack:"fixed"});function collect(){return([{stack:"fixed"}]as{stack?:string}[]).reduce(...([()=>error,{stack:"fixed"}]as const)).stack;}return collect();}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('native reduction spread readers', () => {
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

describe('native reduction spread shared', () => {
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
