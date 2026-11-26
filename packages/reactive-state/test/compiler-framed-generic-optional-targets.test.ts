import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Bare own generic inputs can accept an optional target argument without result instantiation. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-generic-optional-void',
    source:
      'type Data={stack:string};type Source=<T>(input:T)=>T;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-independent-void',
    source:
      'type Data={stack:string};type Source=<T>(input:T)=>void;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-default-is-not-constraint',
    source:
      'type Data={stack:string};type Source=<T=number>(input:T)=>T;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-constraint-allows-undefined',
    source:
      'type Data={stack:string};type Source=<T extends unknown>(input:T)=>T;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'any-constraint-allows-undefined',
    source:
      'type Data={stack:string};type Source=<T extends any>(input:T)=>T;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'number-undefined-constraint',
    source:
      'type Data={stack:string};type Source=<T extends number|undefined>(input:T)=>T;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'string-undefined-constraint',
    source:
      'type Data={stack:string};type Source=<T extends string|undefined>(input:T)=>T;type Target=(input?:string)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-only-compatible-constraint',
    source:
      'type Data={stack:string};type Source=<T extends undefined>(input:T)=>T;type Target=(input?:undefined)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'number-constraint-data-pin',
    source:
      'type Data={stack:string};type Source=<T extends number>(input:T)=>T;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'undefined-only-incompatible-data-pin',
    source:
      'type Data={stack:string};type Source=<T extends undefined>(input:T)=>T;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'Error-constraint-data-pin',
    source:
      'type Data={stack:string};type Source=<T extends Error>(input:T)=>T;type Target=(input?:Error)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nonnull-constraint-data-pin',
    source:
      'type Data={stack:string};type Source=<T extends {}>(input:T)=>T;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nongeneric-required-data-pin',
    source:
      'type Data={stack:string};type Source=(input:number)=>number;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nongeneric-undefined-union-pin',
    source:
      'type Data={stack:string};type Source=(input:number|undefined)=>number;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nongeneric-optional-pin',
    source:
      'type Data={stack:string};type Source=(input?:number)=>number;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extra-required-arity-data-pin',
    source:
      'type Data={stack:string};type Source=<T>(input:T,extra:number)=>T;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'empty-target-arity-data-pin',
    source:
      'type Data={stack:string};type Source=<T>(input:T)=>T;type Target=()=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-result-correlation-data-pin',
    source:
      'type Data={stack:string};type Source=<T>(input:T)=>T;type Target=(input?:number)=>string;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'known-incompatible-result-data-pin',
    source:
      'type Data={stack:string};type Source=<T>(input:T)=>number;type Target=(input?:number)=>string;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-source-alias',
    source:
      'type Data={stack:string};type Maker=<T>(input:T)=>T;type Source=Maker;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'closed-constraint-alias',
    source:
      'type Data={stack:string};type Choice=number|undefined;type Maker=<T extends Choice>(input:T)=>T;type Source=Maker;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'bound-outer-constraint',
    source:
      'type Data={stack:string};type Factory<X>=<T extends X>(input:T)=>T;type Source=Factory<number|undefined>;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'bound-outer-incompatible-data-pin',
    source:
      'type Data={stack:string};type Factory<X>=<T extends X>(input:T)=>T;type Source=Factory<number>;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'own-parameter-shadows-outer',
    source:
      'type Data={stack:string};type Factory<T>=<T>(input:T)=>T;type Source=Factory<Error>;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'void-result-alias',
    source:
      'type Data={stack:string};type Nothing=void;type Source=<T>(input:T)=>T;type Target=(input?:number)=>Nothing;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-result-target',
    source:
      'type Data={stack:string};type Source=<T>(input:T)=>T;type Target=(input?:number)=>unknown;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'any-result-target',
    source:
      'type Data={stack:string};type Source=<T>(input:T)=>T;type Target=(input?:number)=>any;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-construct-unknown-target',
    source:
      'type Data={stack:string};type Source=new<T>(input:T)=>T;type Target=new(input?:number)=>unknown;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-construct-void-target',
    source:
      'type Data={stack:string};type Source=new<T>(input:T)=>T;type Target=new(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'two-known-generic-positions',
    source:
      'type Data={stack:string};type Source=<T>(input:T,other?:string)=>T;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-array-parameter-data-pin',
    source:
      'type Data={stack:string};type Source=<T>(input:T[])=>T[];type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'string-union-constraint-data-pin',
    source:
      'type Data={stack:string};type Source=<T extends string|undefined>(input:T)=>T;type Target=(input?:number)=>void;type Fits=Source extends Target?true:false;type Failure=Source extends Target?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('generic optional target readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'generic-optional-targets.ts', source);
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

describe('shared generic optional target admissions', () => {
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
