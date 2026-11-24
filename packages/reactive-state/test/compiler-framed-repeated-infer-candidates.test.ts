import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Repeated primitive infer candidates retain their written variance and joint result. */
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
    id: 'contra-string-number',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:string)=>void;b:(v:number)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'contra-same-string-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:string)=>void;b:(v:string)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'contra-distinct-literals',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:"a")=>void;b:(v:"b")=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'contra-literal-and-category-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:"a")=>void;b:(v:string)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'contra-disjoint-literal-unions',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:"a"|"b")=>void;b:(v:"c")=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'contra-overlap-literal-unions-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:"a"|"b")=>void;b:(v:"b"|"c")=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'contra-overlap-category-unions-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:string|number|boolean)=>void;b:(v:string|number)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'contra-three-candidates',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void;c:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void;c:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:string)=>void;b:(v:number)=>void;c:(v:boolean)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'contra-original-source-alias',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Unary<T>=(v:T)=>void;type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:Unary<string>;b:Unary<number>}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'contra-original-generic-environments',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Pair<A,B>={a:(v:A)=>void;b:(v:B)=>void};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<Pair<string,number>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'contra-nested-parameter-member',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:{value:infer U})=>void;b:(v:{value:infer U})=>void}?U:"unmatched";type Select<T>=T extends {a:(v:{value:infer U})=>void;b:(v:{value:infer U})=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:{value:string})=>void;b:(v:{value:number})=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'higher-order-existing-opacity-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(cb:(v:infer U)=>void)=>void;b:(cb:(v:infer U)=>void)=>void}?U:"unmatched";type Select<T>=T extends {a:(cb:(v:infer U)=>void)=>void;b:(cb:(v:infer U)=>void)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(cb:(v:string)=>void)=>void;b:(cb:(v:number)=>void)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'method-bivariance-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a(v:infer U):void;b(v:infer U):void}?U:"unmatched";type Select<T>=T extends {a(v:infer U):void;b(v:infer U):void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a(v:string):void;b(v:number):void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'contra-inside-written-return',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:()=>(v:infer U)=>void;b:()=>(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:()=>(v:infer U)=>void;b:()=>(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:()=>(v:string)=>void;b:()=>(v:number)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'covariant-repeated-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:infer U;b:infer U}?U:"unmatched";type Select<T>=T extends {a:infer U;b:infer U}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:string;b:number}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'covariant-single-union-conditional-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:infer U;b:infer U}?U:"unmatched";type Select<T>=T extends {a:infer U;b:infer U}?([U] extends [string]?Error:Data):Data;type Failure=Select<{a:string;b:number}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'contra-never-subtype-refusal-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [string]?Error:Data):Data;type Failure=Select<{a:(v:string)=>void;b:(v:number)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'contra-structural-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:FixedError)=>void;b:(v:Data)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'covariant-native-union-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:infer U;b:infer U}?U:"unmatched";type Select<T>=T extends {a:infer U;b:infer U}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:Error;b:Data}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'contra-number-bigint',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:number)=>void;b:(v:bigint)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'contra-boolean-literals',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:true)=>void;b:(v:false)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'contra-null-undefined',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Captured<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?U:"unmatched";type Select<T>=T extends {a:(v:infer U)=>void;b:(v:infer U)=>void}?([U] extends [never]?Error:Data):Data;type Failure=Select<{a:(v:null)=>void;b:(v:undefined)=>void}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declared-in-alias-retains-refusal-pin',
    source:
      'type Data={stack:string};type Sink<in T>=(value:T)=>void;type Captured<T>=T extends{a:Sink<infer U>;b:Sink<infer U>}?U:never;type Select<T>=T extends{a:Sink<infer U>;b:Sink<infer U>}?([U]extends[string]?Error:Data):Data;type Failure=Select<{a:Sink<string>;b:Sink<number>}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unannotated-alias-retains-refusal-pin',
    source:
      'type Data={stack:string};type Sink<T>=(value:T)=>void;type Captured<T>=T extends{a:Sink<infer U>;b:Sink<infer U>}?U:never;type Select<T>=T extends{a:Sink<infer U>;b:Sink<infer U>}?([U]extends[string]?Error:Data):Data;type Failure=Select<{a:Sink<string>;b:Sink<number>}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('repeated infer candidate readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'repeated-infer-candidates.ts', source);
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

describe('shared repeated infer candidate admissions', () => {
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
