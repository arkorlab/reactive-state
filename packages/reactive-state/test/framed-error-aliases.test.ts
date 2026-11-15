import { describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('the error types a shared module declares locally', () => {
  it.each([
    'type Loop<T = Loop> = T; function read(error: Loop) { return error.stack; }',
    'type Loop<T = T> = T; function read(error: Loop) { return error.stack; }',
    'type Left<T> = Right<T>; type Right<T> = Left<T>; function read(error: Left<Error>) { return error.stack; }',
    'class C { method<Error extends { stack: string }>(error: Error) { return error.stack; } }',
    'class C { ["method"]<Error extends { stack: string }>(error: Error) { return error.stack; } }',
    `const Data = class Error { stack = 'data'; read() { type Wrapped = Error; const self: Wrapped = this; return self.stack; } };`,
    'type Left = Right; type Right = Left; function frames(error: Left) { return error.stack; }',
    'type Wrapped = Error; function frames() { interface Wrapped { stack: string }; function read(error: Wrapped) { return error.stack; } }',
    'type Wrapped = Error; function frames() { class Wrapped { stack = "data"; }; function read(error: Wrapped) { return error.stack; } }',
    'type Wrapped<Error extends { stack: string }> = Error; function read(error: Wrapped<{ stack: string }>) { return error.stack; }',
  ])('stops at cyclic aliases and nearer application type declarations: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'error-types.ts', source);

    expect(unsettledIn(parsed.sourceFile)).toBeUndefined();
  });

  it.each([
    'type Identity<T> = T; function read(error: Identity<Identity<Error>>) { return error.stack; }',
    'type Identity<T = Error> = T; type Box<T = Identity> = T; function read(error: Box) { return error.stack; }',
    'type Builtin = Error; function read<Error>(error: Builtin) { return error.stack; }',
    'type Left<T> = T | Right<T>; type Right<T> = Left<T>; function read(error: Left<Error>) { return error.stack; }',
    'class C { @(((error: Error) => error.stack)(new Error())) method<Error>() {} }',
  ])('reads explicit error aliases in their definition and argument scopes: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'scoped-error-types.ts', source);

    expect(unsettledIn(parsed.sourceFile)).toContain('reads `stack` of an error');
  });
});
