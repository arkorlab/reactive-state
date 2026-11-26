import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native splice returns original removed elements while preserving opaque operation boundaries. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
  readonly files?: Readonly<Record<string, string>>;
}

const CASES: readonly Case[] = [
  {
    id: 'splice-removed-review',
    source: 'function frames(error:Error){return[error].splice(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-supplied-message',
    source: 'function frames(error:Error){return[error].splice(0,1)[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-second-input',
    source: 'function frames(error:Error){return[{stack:"fixed"},error].splice(1,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-second-result',
    source: 'function frames(error:Error){return[{stack:"fixed"},error].splice(0,2)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-negative-start',
    source: 'function frames(error:Error){return[{stack:"fixed"},error].splice(-1,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-no-delete-count',
    source: 'function frames(error:Error){return[{stack:"fixed"},error].splice(1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-negative-infinity',
    source: 'function frames(error:Error){return[error].splice(-Infinity,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-infinite-delete',
    source: 'function frames(error:Error){return[error].splice(0,Infinity)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-nan-start',
    source: 'function frames(error:Error){return[error].splice(NaN,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-fractional-bounds',
    source:
      'function frames(error:Error){return[{stack:"fixed"},error].splice(1.8,1.7)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-primitive-text-bounds',
    source:
      'function frames(error:Error){return([error].splice as(...args:unknown[])=>{stack?:string}[])("0","1")[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-constant-bounds',
    source:
      'function frames(error:Error){const start=-1;const count=1;return[error].splice(start,count)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-whole-array-alias',
    source:
      'function frames(error:Error){const input=[error];const alias=input;return alias.splice(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-error-alias',
    source: 'function frames(error:Error){const value=error;return[value].splice(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-fresh-error-frames',
    source: 'function frames(error:Error){return[new Error("fixed")].splice(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-borrowed-call',
    source:
      'function frames(error:Error){return(Array.prototype.splice.call([error],0,1)as{stack?:string}[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-borrowed-apply',
    source:
      'function frames(error:Error){return(Array.prototype.splice.apply([error],[0,1])as{stack?:string}[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-borrowed-reflect',
    source:
      'function frames(error:Error){return(Reflect.apply(Array.prototype.splice,[error],[0,1])as{stack?:string}[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-borrowed-method-alias',
    source:
      'function frames(error:Error){const remove=Array.prototype.splice;return(remove.call([error],0,1)as{stack?:string}[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-known-own-error-result',
    source:
      'function frames(error:Error){const values:{stack?:string}[]=[{stack:"fixed"}];values.splice=()=>[error];return values.splice(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-local-words-pin',
    source: 'function frames(error:Error){return[new Error("fixed")].splice(0,1)[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-data-pin',
    source: 'function frames(error:Error){return[{stack:"fixed"}].splice(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-excluded-error-pin',
    source: 'function frames(error:Error){return[{stack:"fixed"},error].splice(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-inserted-error-pin',
    source: 'function frames(error:Error){return[{stack:"fixed"}].splice(0,1,error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-zero-delete-pin',
    source: 'function frames(error:Error){return[error].splice(0,0)[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-no-args-pin',
    source:
      'function frames(error:Error){return([error].splice as(...args:unknown[])=>{stack?:string}[])()[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-undefined-delete-pin',
    source:
      'function frames(error:Error){return([error].splice as(...args:unknown[])=>{stack?:string}[])(0,undefined)[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-negative-delete-pin',
    source: 'function frames(error:Error){return[error].splice(0,-1)[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-past-end-pin',
    source: 'function frames(error:Error){return[error].splice(2,1)[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-positive-infinity-start-pin',
    source: 'function frames(error:Error){return[error].splice(Infinity,1)[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-outside-result-pin',
    source: 'function frames(error:Error){return[error].splice(0,1)[2]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-negative-property-pin',
    source: 'function frames(error:Error){return[error].splice(0,1)[-1]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-hole-pin',
    source:
      'function frames(error:Error){return([,error].splice(0,1)as{stack?:string}[])[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-own-method-data-pin',
    source:
      'function frames(error:Error){const values:{stack?:string}[]=[error];values.splice=()=>[{stack:"fixed"}];return values.splice(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-prior-field-rewrite-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return[error].splice(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-insertion-effect-pin',
    source:
      'function frames(error:Error){return[error].splice(0,1,Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-reflect-wrapper-tail-effect-pin',
    source:
      'function frames(error:Error){return(Reflect.apply as(...args:unknown[])=>{stack?:string}[])(Array.prototype.splice,[error],[0,1],Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-apply-wrapper-tail-effect-pin',
    source:
      'function frames(error:Error){return(Array.prototype.splice.apply as(...args:unknown[])=>{stack?:string}[])([error],[0,1],Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-reflect-spread-tail-effect-pin',
    source:
      'function frames(error:Error){const args=[Array.prototype.splice,[error],[0,1],Object.assign(error,{stack:"fixed"})]as const;return(Reflect.apply as(...args:unknown[])=>{stack?:string}[])(...args)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'splice-converting-bound-effect-pin',
    source:
      'function frames(error:Error){const start={valueOf(){Object.assign(error,{stack:"fixed"});return 0;}};return([error].splice as(...args:unknown[])=>{stack?:string}[])(start,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-changed-array-before-call-pin',
    source:
      'function frames(error:Error){const input:{stack?:string}[]=[error];input[0]={stack:"fixed"};return input.splice(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-saved-array-input-write-pin',
    source:
      'function frames(error:Error){const removed=[error].splice(0,1);Object.assign(error,{stack:"fixed"});return removed[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-saved-element-write-pin',
    source:
      'function frames(error:Error){const value=[error].splice(0,1)[0]!;Object.assign(value,{stack:"fixed"});return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-saved-result-opaque-pin',
    source:
      'function frames(error:Error){const removed=[error].splice(0,1);return removed[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-selected-key-effect-pin',
    source:
      'function frames(error:Error){return[error].splice(0,1)[(Object.assign(error,{stack:"fixed"}),0)]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'splice-loop-push',
    source:
      'function frames(error:Error){const values:Error[]=[];let result:unknown;let i=0;do result=values.splice(0)[0]?.stack;while((values.push(error),i++<1));return result;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'splice-loop-push-data',
    source:
      'function frames(error:Error){const values:Error[]=[];const spare:Error[]=[];let result:unknown;let i=0;do result=values.splice(0)[0]?.stack;while((spare.push(error),i++<1));return result;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('splice removed element readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'splice-removed.ts', source);
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

describe('shared splice removed element admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, files }) => {
    const app = await application({
      ...files,
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
