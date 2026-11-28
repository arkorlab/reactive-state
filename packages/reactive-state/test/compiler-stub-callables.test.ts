import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emitStub } from '../src/compiler/emit-app.ts';
import type { ParsedModule } from '../src/compiler/modules.ts';
import { operationCallables } from '../src/compiler/operation-callables.ts';
import { operationExports } from '../src/compiler/operations.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Direct callable annotations retain overloads while every transported result stays promised. */
const SHAPES = [
  {
    id: 'async-overloads',
    count: 2,
    mirrored: false,
    source:
      'export const choose:{(value:string):Promise<string>;(value:number):Promise<number>}=async(value:string|number)=>value as never;',
  },
  {
    id: 'sync-overloads',
    count: 2,
    mirrored: false,
    source:
      'export const choose:{(value:string):string;(value:number):number}=(value:string|number)=>value as never;',
  },
  {
    id: 'mixed-overloads',
    count: 2,
    mirrored: false,
    source:
      'export const choose:{(value:string):string;(value:number):Promise<number>}=(value:string|number)=>value as never;',
  },
  {
    id: 'private-local-alias',
    count: 2,
    mirrored: false,
    source:
      'type Hidden=string&{readonly brand:unique symbol};type Choices={(value:Hidden):Hidden;(value:number):number};type Whole=Choices;export const choose:Whole=(value:Hidden|number)=>value as never;',
  },
  {
    id: 'instantiated-local-alias',
    count: 2,
    mirrored: false,
    source:
      'type Choices<T>={(value:T):T;(value:number):number};export const choose:Choices<string>=(value:string|number)=>value as never;',
  },
  {
    id: 'generic-sync',
    count: 1,
    mirrored: true,
    source: 'export const choose:{<T>(value:T):T}=<T>(value:T)=>value;',
  },
  {
    id: 'generic-mixed-order',
    count: 2,
    mirrored: true,
    source:
      'export const choose:{(value:number):number;<T extends string>(value:T):T}=(value:string|number)=>value as never;',
  },
  {
    id: 'generic-literal-specialization',
    count: 2,
    mirrored: true,
    source:
      "export const choose:{<T extends string>(value:T):T;(value:'special'):42}=(value:string)=>value as never;",
  },
  {
    id: 'native-qualified-type',
    count: 1,
    mirrored: true,
    source: 'export const choose:{<T>(value:T):globalThis.Promise<T>}=async<T>(value:T)=>value;',
  },
  {
    id: 'ordinary-single-signature-pin',
    count: 0,
    mirrored: false,
    source: 'export const choose:{(value:string):string}=(value:string)=>value;',
  },
  {
    id: 'function-annotation-boundary-pin',
    count: 0,
    mirrored: false,
    source: 'export const choose:(value:string)=>string=(value:string)=>value;',
  },
  {
    id: 'imported-annotation-boundary-pin',
    count: 0,
    mirrored: false,
    source:
      "import type {Dispatch} from 'react';export const choose:Dispatch<string>=undefined as never;",
  },
];

const REFUSALS = [
  {
    id: 'inline-nominal-result',
    reason: 'written scope',
    source:
      'export const choose:{<T>(value:T):T&{readonly brand:unique symbol}}=<T>(value:T)=>value as never;',
  },
  {
    id: 'private-generic-constraint',
    reason: 'written scope',
    source:
      'type Hidden={id:string};export const choose:{<T extends Hidden>(value:T):T;(value:number):number}=undefined as never;',
  },
  {
    id: 'outer-alias-generic',
    reason: 'written scope',
    source:
      'type Choices<Outer>={<T extends Outer>(value:T):T};export const choose:Choices<string>=undefined as never;',
  },
  {
    id: 'type-query-in-generic',
    reason: 'written scope',
    source:
      'const fixed="text";export const choose:{<T>(value:T):typeof fixed}=undefined as never;',
  },
  {
    id: 'shadowed-generic-native',
    reason: 'written scope',
    source:
      'type Promise<T>={value:T};export const choose:{<T>(value:T):Promise<T>}=undefined as never;',
  },
  {
    id: 'explicit-receiver',
    reason: 'written receiver',
    source: 'export const choose:{(this:{id:string},value:string):string}=undefined as never;',
  },
];

const SOURCE = `
'use server';
export const choose: {(value:string):Promise<string>;(value:number):Promise<number>}
  = async(value:string|number)=>value as never;
export const syncChoose: {(value:string):string;(value:number):number}
  = (value:string|number)=>value as never;
export const mixed: {(value:string):string;(value:number):Promise<number>}
  = (value:string|number)=>value as never;
type Hidden = string & {readonly brand:unique symbol};
export function hidden():Hidden{return 'hidden' as Hidden;}
export const privateChoose: {(value:Hidden):Hidden;(value:number):number}
  = (value:Hidden|number)=>value as never;
type Choices<T> = {(value:T):T;(value:number):number};
type WholeChoices = Choices<string>;
export const aliased:WholeChoices=(value:string|number)=>value as never;
export const identity:{<T>(value:T):T}=<T>(value:T)=>value;
export const promised:{<T>(value:T):Promise<T>}=async<T>(value:T)=>value;
export const genericFirst:{<T extends string>(value:T):T;(value:number):number}
  = (value:string|number)=>value as never;
export const genericLast:{(value:number):number;<T extends string>(value:T):T}
  = (value:string|number)=>value as never;
export const specialized:{<T extends string>(value:T):T;(value:'special'):42}
  = (value:string)=>value as never;
export const specializedFirst:{(value:'special'):42;<T extends string>(value:T):T}
  = (value:string)=>value as never;
export const optional:{<T extends string=string>(value?:T):T|undefined}
  = <T extends string=string>(value?:T)=>value;
export const tuple:{<const T extends readonly unknown[]>(...values:T):T}
  = <const T extends readonly unknown[]>(...values:T)=>values;
export const shadowed:{<Promise,Awaited,OperationResult$>(one:Promise,two:Awaited,three:OperationResult$):[Promise,Awaited,OperationResult$]}
  = <Promise,Awaited,OperationResult$>(one:Promise,two:Awaited,three:OperationResult$):[Promise,Awaited,OperationResult$]=>[one,two,three];
export const nominal:{(value:string):{readonly brand:unique symbol};(value:number):number}
  = (value:string|number)=>value as never;
export function nominalToken(){return nominal('text');}
export const nominalGuard:{<T>(value:T):value is T&{readonly brand:unique symbol}}
  = (value:unknown):value is never=>{void value;return false;};
`;

const CALLS = `
import type * as original from './source';
const text: string = await operations.choose('text');
const count: number = await operations.choose(1);
const sync: string = await operations.syncChoose('text');
const mixed: string = await operations.mixed('text');
const hidden = await operations.hidden();
const privateResult: typeof hidden = await operations.privateChoose(hidden);
const alias: string = await operations.aliased('text');
const literal: 'kept' = await operations.identity('kept' as const);
const flattened: string = await operations.promised(Promise.resolve('text'));
const first: 'kept' = await operations.genericFirst('kept' as const);
const last: 'kept' = await operations.genericLast('kept' as const);
const specialized: 42 = await operations.specialized('special');
const specializedFirst: 42 = await operations.specializedFirst('special');
const optional: string|undefined = await operations.optional();
const optionalLiteral: 'kept'|undefined = await operations.optional('kept');
const tuple: readonly ['kept',1] = await operations.tuple('kept',1);
const shadowed: ['one',2,true] = await operations.shadowed('one' as const,2 as const,true as const);
const nominal:ReturnType<typeof original.nominalToken> = await operations.nominal('text');
const guarded:boolean = await operations.nominalGuard('text');
// @ts-expect-error a boolean has no written overload
await operations.choose(true);
// @ts-expect-error the result of the string overload remains text
const wrong: number = await operations.choose('text');
// @ts-expect-error the generic result remains correlated with its input
const uncorrelated: 'other' = await operations.identity('kept' as const);
void [text,count,sync,mixed,privateResult,alias,literal,flattened,first,last,specialized,specializedFirst,optional,optionalLiteral,tuple,shadowed,nominal,guarded,wrong,uncorrelated];
`;

const TRANSPORT_CALLS = `
const syncTransport:Promise<string> = operations.syncChoose('text');
const mixedTransport:Promise<string> = operations.mixed('text');
const genericTransport:Promise<'kept'> = operations.identity('kept' as const);
const flattenedTransport:Promise<string> = operations.promised(Promise.resolve('text'));
const guardTransport:Promise<boolean> = operations.nominalGuard('text');
// @ts-expect-error a synchronous source result is promised by its stub
const synchronous:string = operations.syncChoose('text');
void [syncTransport,mixedTransport,genericTransport,flattenedTransport,guardTransport,synchronous];
`;

const PACKAGE = fileURLToPath(new URL('../', import.meta.url));

/** A leased syntax tree with the source metadata the module reader normally supplies. */
function namedModule(sourceFile: ParsedModule['sourceFile'], name: string): ParsedModule {
  return { file: name, name, sourceFile, text: sourceFile.text };
}

/** A source and its generated caller are checked independently by the pinned native compiler. */
async function checked(
  source: string,
  stub: string,
  calls: string,
  generatedOnly = '',
): Promise<void> {
  const directory = await mkdtemp(path.join(PACKAGE, '.operation-stub-types-'));
  try {
    await writeFile(path.join(directory, 'source.ts'), source);
    await writeFile(
      path.join(directory, 'stub.ts'),
      stub.replace("'@arkorlab/reactive-state/next'", "'./transport'"),
    );
    await writeFile(
      path.join(directory, 'transport.ts'),
      'export declare function operate(...args:unknown[]):Promise<unknown>;\n',
    );
    for (const module of ['source', 'stub']) {
      const additions = module === 'stub' ? generatedOnly : '';
      await writeFile(
        path.join(directory, 'caller.ts'),
        `import * as operations from './${module}';\n${calls}\n${additions}`,
      );
      await writeFile(
        path.join(directory, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            noUnusedLocals: true,
            skipLibCheck: true,
            target: 'ES2023',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            types: [],
            lib: ['ES2024', 'DOM'],
          },
          files: ['caller.ts'],
        }),
      );
      const ran = spawnSync(
        process.execPath,
        [path.join(PACKAGE, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', directory],
        { cwd: directory, encoding: 'utf8' },
      );

      expect(`${module}: ${ran.stdout}${ran.stderr}`).toBe(`${module}: `);
      expect(ran.status).toBe(0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('written operation overloads and generic calls', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(SHAPES)('$id', ({ source, count, mirrored }) => {
    using parsed = parseModule(api, 'actions/callables.ts', source);
    const module = namedModule(parsed.sourceFile, 'actions/callables.ts');
    const callable = operationCallables(module).get('choose');

    expect(callable?.count ?? 0).toBe(count);
    expect(callable?.written !== undefined).toBe(mirrored);
  });

  it.each(REFUSALS)('$id', ({ source, reason }) => {
    using parsed = parseModule(api, 'actions/callables.ts', source);

    const module = namedModule(parsed.sourceFile, 'actions/callables.ts');

    expect(() => operationCallables(module)).toThrow(reason);
  });

  it('keeps each overload and generic correlation while synchronous results become promises', async () => {
    using parsed = parseModule(api, 'actions/callables.ts', SOURCE);
    const module = namedModule(parsed.sourceFile, 'actions/callables.ts');
    const stub = emitStub(
      {
        id: 'actions/callables',
        fileName: 'actions/callables.ts',
        specifierFrom: () => "'./source'",
        exports: operationExports(module),
        callables: operationCallables(module),
      },
      'actions/callables.ts',
      'b_BUILD',
    );

    await expect(checked(SOURCE, stub, CALLS, TRANSPORT_CALLS)).resolves.toBeUndefined();
  });

  it('keeps a generic-only stub free of unused imports and captures no source generic binder', async () => {
    const source =
      'export const identity:{<Promise,Awaited,OperationResult$>(value:[Promise,Awaited,OperationResult$]):[Promise,Awaited,OperationResult$]}=<Promise,Awaited,OperationResult$>(value:[Promise,Awaited,OperationResult$])=>value;';
    using parsed = parseModule(api, 'actions/generic.ts', source);
    const module = namedModule(parsed.sourceFile, 'actions/generic.ts');
    const stub = emitStub(
      {
        id: 'actions/generic',
        fileName: 'actions/generic.ts',
        specifierFrom: () => "'./source'",
        exports: ['identity'],
        callables: operationCallables(module),
      },
      'actions/generic.ts',
      'b_BUILD',
    );

    await expect(
      checked(
        source,
        stub,
        "const tuple:['kept',1,true]=await operations.identity(['kept' as const,1 as const,true as const]);void tuple;",
      ),
    ).resolves.toBeUndefined();
  });
});
