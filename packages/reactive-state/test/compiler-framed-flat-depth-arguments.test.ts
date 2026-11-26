import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native flat depth arguments retain the written array layers and original evaluation order. */
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
    id: 'flat-depth-spread-zero',
    source: 'function frames(error:Error){return [[error]].flat(...([0]as const))[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-spread-negative',
    source:
      'function frames(error:Error){return ([[error]].flat(...([-1]as const))as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-spread-false',
    source:
      'function frames(error:Error){return ([[error]].flat(...([false]as unknown as[number]))as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-spread-null',
    source:
      'function frames(error:Error){return ([[error]].flat(...([null]as unknown as[number]))as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-spread-one',
    source:
      'function frames(error:Error){return [[[error]]].flat(...([1]as const))[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-spread-two',
    source:
      'function frames(error:Error){return [[[[error]]]].flat(...([2]as const))[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-whole-tuple-alias',
    source:
      'function frames(error:Error){const depths=[0]as const;return [[error]].flat(...depths)[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-nested-argument-spread',
    source:
      'function frames(error:Error){return [[error]].flat(...([...([0]as const)]as const))[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-borrowed-call-spread',
    source:
      'function frames(error:Error){return(Array.prototype.flat.call([[error]],...([0]as const))as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-borrowed-apply-spread',
    source:
      'function frames(error:Error){return(Array.prototype.flat.apply([[error]],[...([0]as const)])as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-reflect-apply-spread',
    source:
      'function frames(error:Error){return(Reflect.apply(Array.prototype.flat,[[error]],[...([0]as const)])as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-number-zero',
    source:
      'function frames(error:Error,depth:number){return([[error]].flat(depth)as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"),0)',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-number-intermediate',
    source:
      'function frames(error:Error,depth:number){return([[[error]]].flat(depth)as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"),1)',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-direct-zero-pin',
    source: 'function frames(error:Error){return [[error]].flat(0)[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-spread-default-pin',
    source: 'function frames(error:Error){return [[error]].flat(...([]as const))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-spread-undefined-pin',
    source:
      'function frames(error:Error){return ([[error]].flat(...([undefined]as const))as unknown as{stack?:string}[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-spread-infinity-pin',
    source:
      'function frames(error:Error){return ([[[error]]].flat(...([Infinity]as const))as unknown as{stack?:string}[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-known-one-data',
    source:
      'function frames(error:Error){return([[error]].flat(...([1]as const))[0]as unknown as{0?:{stack:string}})[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-depth-literal-parameter-data',
    source:
      'function frames(error:Error,depth:1){return([[error]].flat(depth)[0]as unknown as{0?:{stack:string}})[0]?.stack;}',
    invocation: 'frames(new Error("ours"),1)',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-depth-alias-parameter-data',
    source:
      'type Depth=1;function frames(error:Error,depth:Depth){return([[error]].flat(depth)[0]as unknown as{0?:{stack:string}})[0]?.stack;}',
    invocation: 'frames(new Error("ours"),1)',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-depth-own-method-data',
    source:
      'function frames(error:Error){const values=[[error]];values.flat=()=>[[{stack:"fixed"}]]as never;return values.flat(...([0]as const))[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-local-words-data',
    source:
      'function frames(_error:Error){return [[new Error("fixed")]].flat(...([0]as const))[0]![0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-depth-written-stack-data',
    source:
      'function frames(error:Error,depth:number){Object.assign(error,{stack:"fixed"});return([[error]].flat(depth)as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"),0)',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-depth-ignored-tail-writes-data',
    source:
      'function frames(error:Error){return ([[error]].flat(...([0,Object.assign(error,{stack:"fixed"})]as unknown as[number]))as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-depth-saved-result-write-data',
    source:
      'function frames(error:Error){const result=[[error]].flat(...([0]as const));Object.assign(error,{stack:"fixed"});return result[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-depth-known-array-data',
    source:
      'function frames(error:Error,depth:number){return([[{stack:"fixed"}]].flat(depth)as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"),0)',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-depth-ordinary-function-data',
    source:
      'function frames(error:Error){const values={flat(_depth:number){return[[{stack:"fixed"}]];}};return values.flat(...([0]as const))[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-uniform-domain-data',
    source:
      'function frames(error:Error,depth:number){return([[error],[{stack:"fixed"}]].flat(depth)as unknown as{stack?:string}[])[1]?.stack;}',
    invocation: 'frames(new Error("ours"),1)',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-optional-zero-default',
    source:
      'function frames(error:Error,depth?:0){return([[[error]]].flat(depth)as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-number-alias',
    source:
      'type Depth=number;function frames(error:Error,depth:Depth){return([[error]].flat(depth)as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"),0)',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-string-zero',
    source:
      'function frames(error:Error,depth:string){return(([[error]].flat as(...args:unknown[])=>unknown)(depth)as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"),"0")',
    reader: true,
    refused: true,
  },
  {
    id: 'flat-depth-object-conversion-data',
    source:
      'function frames(error:Error){const depth={valueOf(){Object.assign(error,{stack:"fixed"});return 0;}};return([[error]].flat(depth as unknown as number)as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-depth-prior-prepare-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return [[value]].flat(...([0]as const))[0]![0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-depth-apply-ignored-tail-data',
    source:
      'function frames(error:Error){return((Array.prototype.flat.apply as(...args:unknown[])=>unknown)([[error]],[...([0]as const)],Object.assign(error,{stack:"fixed"}))as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'flat-depth-literal-union-data',
    source:
      'function frames(error:Error,depth:1|2){return([[error]].flat(depth)[0]as unknown as{0?:{stack:string}})[0]?.stack;}',
    invocation: 'frames(new Error("ours"),1)',
    reader: false,
    refused: false,
  },
  {
    id: 'repeated-zero-alias-still-native-zero',
    source:
      'type Zero=0;type Depth=Zero|Zero;function frames(error:Error,depth:Depth){return([[error]].flat(depth)as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"),0)',
    reader: true,
    refused: true,
  },
  {
    id: 'repeated-one-alias-stays-data',
    source:
      'type One=1;type Depth=One|One;function frames(error:Error,depth:Depth){return([[error]].flat(depth)[0]as unknown as{0?:{stack:string}})[0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"),1)',
    reader: false,
    refused: false,
  },
  {
    id: 'alias-annotation-does-not-change-actual-one',
    source:
      'function frames(error:Error,depth:1){const d:0=depth as 0;return([[error]].flat(d)as unknown as{stack?:string}[][])[0]![0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"),1)',
    reader: false,
    refused: false,
  },
  {
    id: 'unannotated-alias-preserves-one-data',
    source:
      'function frames(error:Error,depth:1){const d=depth;return([[error]].flat(d)as unknown as{stack?:string}[][])[0]![0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"),1)',
    reader: false,
    refused: false,
  },
  {
    id: 'alias-annotation-cannot-hide-zero',
    source:
      'function frames(error:Error,depth:0){const d:1=depth as 1;return([[error]].flat(d)as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"),0)',
    reader: true,
    refused: true,
  },
  {
    id: 'unannotated-alias-preserves-zero',
    source:
      'function frames(error:Error,depth:0){const d=depth;return([[error]].flat(d)as unknown as{stack?:string}[][])[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"),0)',
    reader: true,
    refused: true,
  },
  {
    id: 'alias-chain-preserves-actual-one',
    source:
      'function frames(error:Error,depth:1){const d:0=depth as 0;const next=d;return([[error]].flat(next)as unknown as{stack?:string}[][])[0]![0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"),1)',
    reader: false,
    refused: false,
  },
  {
    id: 'optional-alias-preserves-default-one',
    source:
      'function frames(error:Error,depth?:1){const d:0=depth as 0;return([[error]].flat(d)as unknown as{stack?:string}[][])[0]![0]?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('flat depth argument readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'filter-results.ts', source);
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

describe('shared flat depth argument admissions', () => {
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
