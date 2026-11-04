import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Explicit callable value queries retain their actual written type arguments. */
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
    id: 'declaration-returntype-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T>(value:T):T{return value;}type Failure=ReturnType<typeof make<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declaration-returntype-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T>(value:T):T{return value;}type Failure=ReturnType<typeof make<Data>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'declaration-parameters-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T>(value:T):T{return value;}type Failure=Parameters<typeof make<Error>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'declaration-parameters-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T>(value:T):T{return value;}type Failure=Parameters<typeof make<Data>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'arrow-returntype-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make=<T,>(value:T):T=>value;type Failure=ReturnType<typeof make<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'arrow-returntype-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make=<T,>(value:T):T=>value;type Failure=ReturnType<typeof make<Data>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'arrow-parameters-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make=<T,>(value:T):T=>value;type Failure=Parameters<typeof make<Error>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'arrow-parameters-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make=<T,>(value:T):T=>value;type Failure=Parameters<typeof make<Data>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'expression-returntype-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make=function<T>(value:T):T{return value;};type Failure=ReturnType<typeof make<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'expression-returntype-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make=function<T>(value:T):T{return value;};type Failure=ReturnType<typeof make<Data>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'expression-parameters-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make=function<T>(value:T):T{return value;};type Failure=Parameters<typeof make<Error>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'expression-parameters-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make=function<T>(value:T):T{return value;};type Failure=Parameters<typeof make<Data>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'whole-alias-returntype-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T>(value:T):T{return value;}const copied=make;type Failure=ReturnType<typeof copied<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-alias-returntype-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T>(value:T):T{return value;}const copied=make;type Failure=ReturnType<typeof copied<Data>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'whole-alias-parameters-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T>(value:T):T{return value;}const copied=make;type Failure=Parameters<typeof copied<Error>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-alias-parameters-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T>(value:T):T{return value;}const copied=make;type Failure=Parameters<typeof copied<Data>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'inline-annotation-returntype-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make:<T>(value:T)=>T=<T,>(value:T):T=>value;type Failure=ReturnType<typeof make<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inline-annotation-returntype-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make:<T>(value:T)=>T=<T,>(value:T):T=>value;type Failure=ReturnType<typeof make<Data>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'inline-annotation-parameters-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make:<T>(value:T)=>T=<T,>(value:T):T=>value;type Failure=Parameters<typeof make<Error>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inline-annotation-parameters-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make:<T>(value:T)=>T=<T,>(value:T):T=>value;type Failure=Parameters<typeof make<Data>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'alias-annotation-returntype-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Maker=<T>(value:T)=>T;const make:Maker=<T,>(value:T):T=>value;type Failure=ReturnType<typeof make<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias-annotation-returntype-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Maker=<T>(value:T)=>T;const make:Maker=<T,>(value:T):T=>value;type Failure=ReturnType<typeof make<Data>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'alias-annotation-parameters-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Maker=<T>(value:T)=>T;const make:Maker=<T,>(value:T):T=>value;type Failure=Parameters<typeof make<Error>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'alias-annotation-parameters-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Maker=<T>(value:T)=>T;const make:Maker=<T,>(value:T):T=>value;type Failure=Parameters<typeof make<Data>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'qualified-annotation-returntype-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const holder:{make:<T>(value:T)=>T}={make:<T,>(value:T):T=>value};type Failure=ReturnType<typeof holder.make<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'qualified-annotation-returntype-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const holder:{make:<T>(value:T)=>T}={make:<T,>(value:T):T=>value};type Failure=ReturnType<typeof holder.make<Data>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'qualified-annotation-parameters-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const holder:{make:<T>(value:T)=>T}={make:<T,>(value:T):T=>value};type Failure=Parameters<typeof holder.make<Error>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'qualified-annotation-parameters-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const holder:{make:<T>(value:T)=>T}={make:<T,>(value:T):T=>value};type Failure=Parameters<typeof holder.make<Data>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'constrained-explicit-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T extends Error>(value:T):T{return value;}type Failure=ReturnType<typeof make<FixedError>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'uninstantiated-constraint-error-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T extends Error>(value:T):T{return value;}type Failure=ReturnType<typeof make>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'partial-default-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T,U=T>(value:T):U{return value as never;}type Failure=ReturnType<typeof make<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'partial-default-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T,U=T>(value:T):U{return value as never;}type Failure=ReturnType<typeof make<Data>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'annotation-precedence-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};const make:<T>(value:T)=>Data=<T,>(value:T):Data=>({stack:"fixed"});type Failure=ReturnType<typeof make<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'query-generic-alias-scope-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T>(value:T):T{return value;}type Select<U>=ReturnType<typeof make<U>>;type Failure=Select<Error>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'query-local-type-shadow-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Error=Data;function make<T>(value:T):T{return value;}type Failure=ReturnType<typeof make<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'same-declaration-different-query-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T>(value:T):T{return value;}type First=ReturnType<typeof make<Error>>;type Second=ReturnType<typeof make<Data>>;type Failure=First;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'same-declaration-different-query-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T>(value:T):T{return value;}type First=ReturnType<typeof make<Error>>;type Second=ReturnType<typeof make<Data>>;type Failure=Second;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-overload-before-nongeneric',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T>(value:T):T;function make(value:string):Data;function make(value:unknown):unknown{return value;}type Failure=ReturnType<typeof make<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-outer-constraint-data-pin',
    source:
      'function make<T>(value:T):T{return value;}function frames<U extends Error>(value:ReturnType<typeof make<U>>){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'parameters-outer-constraint-data-pin',
    source:
      'function make<T>(value:T):T{return value;}function frames<U extends Error>(value:Parameters<typeof make<U>>[0]){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'returntype-open-query-keeps-legacy-overload-pin',
    source:
      'function make<T>(value:T):T;function make(value:string):Error;function make(value:unknown):unknown{return value;}function frames<U extends Error>(value:ReturnType<typeof make<U>>){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'parameters-open-query-keeps-legacy-overload-pin',
    source:
      'function make<T>(value:T):T;function make(value:Error):unknown;function make(value:unknown):unknown{return value;}function frames<U extends Error>(value:Parameters<typeof make<U>>[0]){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-outer-alias-constraint-data-pin',
    source:
      'type Box<T>={failure:T};function make<T>(value:T):T{return value;}function frames<U extends Error>(value:ReturnType<typeof make<Box<U>>>){return value.failure.stack;}',
    invocation: 'frames({failure:{name:"Fixed",message:"fixed",stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'parameters-outer-alias-constraint-data-pin',
    source:
      'type Box<T>={failure:T};function make<T>(value:T):T{return value;}function frames<U extends Error>(value:Parameters<typeof make<Box<U>>>[0]){return value.failure.stack;}',
    invocation: 'frames({failure:{name:"Fixed",message:"fixed",stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'query-closed-nested-alias-error',
    source:
      'type Data={stack:string};type Box<T>={failure:T};function make<T>(value:T):T{return value;}type Failure=ReturnType<typeof make<Box<Error>>>;function frames(value:Failure){return value.failure.stack;}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
  },
  {
    id: 'query-closed-nested-alias-data',
    source:
      'type Data={stack:string};type Box<T>={failure:T};function make<T>(value:T):T{return value;}type Failure=ReturnType<typeof make<Box<Data>>>;function frames(value:Failure){return value.failure.stack;}',
    invocation: 'frames({failure:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'inferred-rest-argument-error',
    source:
      'function make<T>(value:T):T{return value;}type Select<T>=T extends [...infer U]?ReturnType<typeof make<U>>[0]:never;type Failure=Select<[Error]>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'inferred-rest-argument-data',
    source:
      'function make<T>(value:T):T{return value;}type Select<T>=T extends [...infer U]?ReturnType<typeof make<U>>[0]:never;type Failure=Select<[{stack:string}]>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('callable query argument readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'callable-query-arguments.ts', source);
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

describe('shared callable query argument admissions', () => {
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
