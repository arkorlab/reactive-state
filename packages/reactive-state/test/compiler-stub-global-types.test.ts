import { describe, expect, it } from 'vitest';

import { emitStub } from '../src/compiler/emit-app.ts';
import { operationCallables } from '../src/compiler/operation-callables.ts';
import { checkSyntax, openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Global type identity survives copying; source-private declarations remain unavailable. */
const CASES = [
  {
    id: 'intrinsic-uppercase',
    source: 'export const choose:{<T extends string>(value:T):Uppercase<T>}=undefined as never;',
    allowed: true,
    call: "operations.choose('mixed' as const)",
    result: "Uppercase<'mixed'>",
  },
  {
    id: 'intrinsic-lowercase',
    source: 'export const choose:{<T extends string>(value:T):Lowercase<T>}=undefined as never;',
    allowed: true,
    call: "operations.choose('mixed' as const)",
    result: "Lowercase<'mixed'>",
  },
  {
    id: 'intrinsic-capitalize',
    source: 'export const choose:{<T extends string>(value:T):Capitalize<T>}=undefined as never;',
    allowed: true,
    call: "operations.choose('mixed' as const)",
    result: "Capitalize<'mixed'>",
  },
  {
    id: 'intrinsic-uncapitalize',
    source: 'export const choose:{<T extends string>(value:T):Uncapitalize<T>}=undefined as never;',
    allowed: true,
    call: "operations.choose('mixed' as const)",
    result: "Uncapitalize<'mixed'>",
  },
  {
    id: 'native-uint8array',
    source: 'export const choose:{<T extends Uint8Array>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'native-headers',
    source: 'export const choose:{<T extends Headers>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'native-readablestream',
    source:
      'export const choose:{<T extends ReadableStream<string>>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'native-disposable',
    source: 'export const choose:{<T extends Disposable>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'native-arrayiterator',
    source:
      'export const choose:{<T extends ArrayIterator<string>>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'native-iteratorobject',
    source:
      'export const choose:{<T extends IteratorObject<string>>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'native-url',
    source: 'export const choose:{<T extends URL>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'native-weakref',
    source:
      'export const choose:{<T extends WeakRef<object>>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'global-headers',
    source:
      'export const choose:{<T extends globalThis.Headers>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'global-utility',
    source:
      'export const choose:{<T extends globalThis.Uppercase<string>>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'intl',
    source:
      'export const choose:{<T extends Intl.DateTimeFormat>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'global-intl',
    source:
      'export const choose:{<T extends globalThis.Intl.NumberFormat>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'webassembly',
    source:
      'export const choose:{<T extends WebAssembly.Module>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'repeated-global',
    source:
      'export const choose:{<T extends globalThis.globalThis.Headers>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'existing-map-control',
    source:
      'export const choose:{<T extends Map<string,string>>(value:string):string}=undefined as never;',
    allowed: true,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'own-binder-control',
    source: 'export const choose:{<Uppercase>(value:Uppercase):Uppercase}=undefined as never;',
    allowed: true,
    call: "operations.choose('kept' as const)",
    result: "'kept'",
  },
  {
    id: 'local-type-shadow',
    source:
      'type Uppercase=string;export const choose:{<T extends Uppercase>(value:T):T}=undefined as never;',
    allowed: false,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'local-namespace-shadow',
    source:
      'namespace Intl{export type DateTimeFormat=string;}export const choose:{<T extends Intl.DateTimeFormat>(value:T):T}=undefined as never;',
    allowed: false,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'value-namespace-shadow',
    source:
      'const Intl={};void Intl;export const choose:{<T extends Intl.DateTimeFormat>(value:string):string}=undefined as never;',
    allowed: false,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'global-namespace-shadow',
    source:
      'namespace globalThis{export type Headers=string;}export const choose:{<T extends globalThis.Headers>(value:T):T}=undefined as never;',
    allowed: false,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'import-type-shadow',
    source:
      "import type {Headers} from './auxiliary';export const choose:{<T extends Headers>(value:T):T}=undefined as never;",
    allowed: false,
    call: "operations.choose('fixed')",
    result: 'string',
  },
  {
    id: 'import-namespace-shadow',
    source:
      "import type * as Types from './auxiliary';export const choose:{<T extends Types.Text>(value:T):T}=undefined as never;",
    allowed: false,
    call: "operations.choose('fixed')",
    result: 'string',
  },
];

describe('operation generic global types', () => {
  it.each(CASES.filter((item) => item.allowed))('$id', ({ source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'actions/global-types.ts', source);
    const module = {
      file: 'actions/global-types.ts',
      name: 'actions/global-types.ts',
      sourceFile: parsed.sourceFile,
      text: source,
    };
    const callables = operationCallables(module);

    expect(callables.get('choose')?.written).toHaveLength(1);

    const stub = emitStub(
      {
        id: 'actions/global-types',
        fileName: 'actions/global-types.ts',
        written: "'./source'",
        exports: ['choose'],
        callables,
      },
      'b_BUILD',
    );

    expect(() => {
      checkSyntax(api, 'global-types.stub.ts', stub, 'generated');
    }).not.toThrow();
  });

  it.each(CASES.filter((item) => !item.allowed))('$id', ({ source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'actions/global-types.ts', source);
    const module = {
      file: 'actions/global-types.ts',
      name: 'actions/global-types.ts',
      sourceFile: parsed.sourceFile,
      text: source,
    };

    expect(() => operationCallables(module)).toThrow('written scope');
  });
});
