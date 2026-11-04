import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Known disjoint structural contravariant infer candidates retain a joint scoped intersection. */
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
    id: 'exact-report-nongeneric',
    source:
      'type Failure={a:(x:{a:string})=>void;b:(x:{b:number})=>void}extends{a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends{a:string;b:number}?Error:{stack:string}):never;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reported-object-contravariance',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source=Pair<{a:string},{b:number}>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'joint-shape-inverse-data',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source=Pair<{a:string},{b:number}>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:string;b:number}?Data:Error):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'reversed-candidate-order',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source=Pair<{b:number},{a:string}>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'three-object-candidates',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source={a:(x:{a:string})=>void;b:(x:{b:number})=>void;c:(x:{c:boolean})=>void};type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void;c:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void;c:(x:infer U)=>void}?(U extends {a:string;b:number;c:boolean}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'readonly-disjoint-fields',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source=Pair<{readonly a:string},{readonly b:number}>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'optional-disjoint-fields',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source=Pair<{a?:string},{b?:number}>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a?:string;b?:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'missing-required-field-data',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source=Pair<{a:string},{b:number}>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:string;b:number;c:boolean}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'incompatible-selected-field-data',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source=Pair<{a:string},{b:number}>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:number;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'whole-type-aliases',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Left={a:string};type Right={b:number};type Source=Pair<Left,Right>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'separate-generic-actuals',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Left<T>={a:T};type Right<T>={b:T};type Source=Pair<Left<string>,Right<number>>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'outer-generic-body-context',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Make<X,Y>=Pair<{a:X},{b:Y}>;type Source=Make<string,number>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-actual-aliases',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Left<T>={a:T};type Right<T>={b:T};type Word=string;type Count=number;type Source=Pair<Left<Word>,Right<Count>>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'defaulted-alias-context',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Left<T=string>={a:T};type Right<T=number>={b:T};type Source=Pair<Left,Right>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'computed-literal-record-names',
    source:
      "type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source=Pair<{['a']:string},{['b']:number}>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'same-structural-source-pin',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Same={a:string};type Source=Pair<Same,Same>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {a:string}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'overlapping-common-field-data-pin',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source=Pair<{a:string;tag:"ok"},{b:number;tag:"ok"}>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {tag:"ok"}?Data:Error):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'overlapping-optional-data-pin',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source=Pair<{a:string;tag?:"ok"},{b:number;tag?:"ok"}>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {tag?:"ok"}?Data:Error):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'union-constituent-opaque-data-pin',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source=Pair<{a:string}|{c:boolean},{b:number}>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?([U] extends [{a:string;b:number}]?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'overlapping-generic-environments-data-pin',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Box<T>={value:T};type Source=Pair<Box<string>,Box<number>>;type Captured<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:(x:infer U)=>void;b:(x:infer U)=>void}?(U extends {value:string|number}?Data:Error):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'covariant-object-union-data-pin',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source={a:{a:string};b:{b:number}};type Captured<T>=T extends {a:infer U;b:infer U}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:infer U;b:infer U}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'mixed-variance-object-data-pin',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source={a:{a:string};b:(x:{a:string}|{b:number})=>void};type Captured<T>=T extends {a:infer U;b:(x:infer U)=>void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:infer U;b:(x:infer U)=>void}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'method-bivariance-object-data-pin',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source={a(x:{a:string}):void;b(x:{b:number}):void};type Captured<T>=T extends {a(x:infer U):void;b(x:infer U):void}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a(x:infer U):void;b(x:infer U):void}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'construct-parameter-object-intersection',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source={a:new(x:{a:string})=>unknown;b:new(x:{b:number})=>unknown};type Captured<T>=T extends {a:new(x:infer U)=>unknown;b:new(x:infer U)=>unknown}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:new(x:infer U)=>unknown;b:new(x:infer U)=>unknown}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-signature-parameter-intersection',
    source:
      'type Data={stack:string};type Pair<A,B>={a:(x:A)=>void;b:(x:B)=>void};type Source={a:{(x:{a:string}):void};b:{(x:{b:number}):void}};type Captured<T>=T extends {a:{(x:infer U):void};b:{(x:infer U):void}}?U:never;type Raw=Captured<Source>;type Select<T>=T extends {a:{(x:infer U):void};b:{(x:infer U):void}}?(U extends {a:string;b:number}?Error:Data):Data;type Failure=Select<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('contravariant object infer candidate readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'contravariant-object-inference.ts', source);
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

describe('shared contravariant object infer candidate admissions', () => {
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
