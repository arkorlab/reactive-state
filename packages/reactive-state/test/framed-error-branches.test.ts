import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Explicit error types retained by conditional aliases and local class inheritance. */
describe('error aliases with conditional branches and local bases', () => {
  it.each([
    'function other(Error: unknown) { return Error; } class Failure extends Error {} function read(error: Failure) { return error.stack; }',
    'function other(globalThis: unknown) { return globalThis; } class Failure extends globalThis.Error {} function read(error: Failure) { return error.stack; }',
    "function other(globalThis: unknown) { return globalThis; } class Failure extends globalThis['Error'] {} function read(error: Failure) { return error.stack; }",
    'type Wrapped<T> = T extends true ? Error : { stack: string }; function read(error: Wrapped<boolean>) { return error.stack; }',
    'type Wrapped<T> = T extends \'x\' ? Error : { stack: string }; function read(error: Wrapped<"x">) { return error.stack; }',
    'type Wrapped<T> = T extends 1 ? Error : { stack: string }; function read(error: Wrapped<1.0>) { return error.stack; }',
    'type Wrapped<T> = T extends 1 ? Error : { stack: string }; function read(error: Wrapped<0x1>) { return error.stack; }',
    'class Base extends globalThis.Error {} class Failure extends (Base) {} function read(error: Failure) { return error.stack; }',
    'class Base extends globalThis.Error {} class Failure extends (Base as typeof Base) {} function read(error: Failure) { return error.stack; }',
    'type Wrapped<T> = T extends never ? Error : { stack: string }; function read(error: Wrapped<any>) { return error.stack; }',
    'type Wrapped = never extends string ? Error : { stack: string }; function read(error: Wrapped) { return error.stack; }',
    'type Empty = never; type Wrapped = Empty extends string ? Error : { stack: string }; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped<T> = T extends 2 ? { stack: string } : Error; function read(error: Wrapped<1>) { return error.stack; }',
    'type Wrapped<T> = T extends unknown ? T : never; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Identity<T> = T extends unknown ? T : never; type Wrapped<T = TypeError> = Identity<T>; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped<T> = T extends string ? { stack: string } : T; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Wrapped<T> = T extends string ? T : Error; function read(error: Wrapped<number>) { return error.stack; }',
    'class Error extends globalThis.Error {} function read(error: Error) { return error.stack; }',
    'class Failure extends globalThis.TypeError {} class Error extends Failure {} function read(error: Error) { return error.stack; }',
    'class Failure<T> extends globalThis.Error {} type Wrapped<T> = Failure<T>; function read(error: Wrapped<string>) { return error.stack; }',
  ])('refuses declared engine frames: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'conditional-error-types.ts', source);

    expect(unsettledIn(parsed.sourceFile)).toContain('reads `stack` of an error');
  });

  it.each([
    'class Data { stack = "data"; } function within(Error: typeof Data) { class Failure extends Error {} function read(error: Failure) { return error.stack; } }',
    'const globalThis = { Error: class { stack = "data"; } }; class Failure extends globalThis.Error {} function read(error: Failure) { return error.stack; }',
    'class Data { stack = "data"; } function within(globalThis: { Error: typeof Data }) { class Failure extends globalThis.Error {} function read(error: Failure) { return error.stack; } }',
    'type Wrapped<T> = T extends Error ? { stack: string } : Error; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Builtin = Error; type Wrapped<T> = T extends Builtin ? { stack: string } : Error; function read(error: Wrapped<Builtin>) { return error.stack; }',
    'type Wrapped<T> = T extends Error ? Error : { stack: string }; function read(error: Wrapped<string>) { return error.stack; }',
    'type Identity<T> = T; type Wrapped<T> = Identity<T> extends unknown ? Error : { stack: string }; function read(error: Wrapped<never>) { return error.stack; }',
    'type Wrapped<T> = T extends 1 ? Error : { stack: string }; function read(error: Wrapped<unknown>) { return error.stack; }',
    'type Wrapped<T> = T extends 1 ? { stack: string } : Error; function read(error: Wrapped<1>) { return error.stack; }',
    'type Wrapped<T> = T extends void ? { stack: string } : Error; function read(error: Wrapped<undefined>) { return error.stack; }',
    'type Wrapped<T> = T extends unknown ? Error : { stack: string }; function read(error: Wrapped<never>) { return error.stack; }',
    'type Wrapped<T> = T extends unknown ? T : never; function read(error: Wrapped<{ stack: string }>) { return error.stack; }',
    'type Wrapped<T> = T extends unknown ? { stack: string } : Error; function read(error: Wrapped<Error>) { return error.stack; }',
    'type Wrapped<T> = T extends string ? Error : { stack: string }; function read(error: Wrapped<number>) { return error.stack; }',
    'type Wrapped<T> = T extends number ? Error : { stack: string }; function read(error: Wrapped<string>) { return error.stack; }',
    'type Loop<T> = T extends unknown ? Loop<T> : Error; function read(error: Loop<Error>) { return error.stack; }',
    'class Error { stack = "data"; } function read(error: Error) { return error.stack; }',
    'class Data { stack = "data"; } class Error extends Data {} function read(error: Error) { return error.stack; }',
    'class Error<T> { stack = "data"; } function read(error: Error<globalThis.Error>) { return error.stack; }',
    'class Left extends Right {} class Right extends Left {} function read(error: Left) { return error.stack; }',
    'import type { Error } from "./error-data"; type Wrapped<T> = T extends unknown ? T : never; function read(error: Wrapped<Error>) { return error.stack; }',
  ])('keeps conditional data, class shadows and cycles: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'conditional-data-types.ts', source);
    const frames: string[] = [];
    const visit = (node: typeof parsed.sourceFile | Parameters<typeof framedRead>[0]): void => {
      const framed = framedRead(node);
      if (framed !== undefined) frames.push(framed);
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);

    expect(frames).toStrictEqual([]);
  });
});
