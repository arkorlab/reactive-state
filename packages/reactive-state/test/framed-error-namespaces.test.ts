import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('the error types a shared module qualifies through local namespaces', () => {
  it.each([
    'declare namespace Types { type Failure = Error } function read(error: Types.Failure) { return error.stack; }',
    'namespace Types { export type Failure = Error } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { namespace Nested { type Failure = Error } } function read(error: Types.Nested.Failure) { return error.stack; }',
    'declare namespace Types.Nested { type Failure = Error } function read(error: Types.Nested.Failure) { return error.stack; }',
    'namespace Types { export namespace Nested { export type Failure = Error } } function read(error: Types.Nested.Failure) { return error.stack; }',
    'declare namespace Types { type Other = string } declare namespace Types { type Failure = Error } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { type Base = Error; type Failure = Base } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { type Base = Error } declare namespace Types { type Failure = Base } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { type Failure = Base } declare namespace Types { type Base = Error } function read(error: Types.Failure) { return error.stack; }',
    'namespace Types { export type Base = Error } namespace Types { export type Failure = Base } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { namespace Nested { type Base = Error } } declare namespace Types { namespace Nested { type Failure = Base } } function read(error: Types.Nested.Failure) { return error.stack; }',
    'declare namespace Types.Nested { type Base = Error } declare namespace Types.Nested { type Failure = Base } function read(error: Types.Nested.Failure) { return error.stack; }',
    'namespace Outer { export namespace Types { export type Failure = Error } } namespace Outer { export function read(error: Types.Failure) { return error.stack; } }',
    'namespace Types { type Error = { stack: string } } namespace Types { export type Failure = Error } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Imported { interface Data { stack: string } } declare namespace Types { import Error = Imported.Data } declare namespace Types { type Failure = Error } function read(error: Types.Failure) { return error.stack; }',
    'namespace Outer { namespace Types { export type Error = { stack: string } } } namespace Outer { namespace Types { export type Failure = Error } export function read(error: Types.Failure) { return error.stack; } }',
    'declare namespace Types { type Failure<T> = T } function read(error: Types.Failure<Error>) { return error.stack; }',
    'declare namespace Types { type Failure<T = Error> = T } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { type Failure = Types.Loop | Error; type Loop = Types.Failure } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { type Failure = Error } namespace Inner { type Types = string; export function read(error: Types.Failure) { return error.stack; } }',
    'declare namespace Types { type Failure = Error } namespace Inner { interface Types {} export function read(error: Types.Failure) { return error.stack; } }',
    'declare namespace Types { type Failure = Error } namespace Inner { class Types {} export function read(error: Types.Failure) { return error.stack; } }',
    'declare namespace Types { type Failure = Error } namespace Inner { export function read<Types>(error: Types.Failure) { return error.stack; } }',
    'declare namespace Types { type Failure = Error } namespace Inner { export function read(Types: unknown, error: Types.Failure) { return error.stack; } }',
  ])('reads the error alias of a local namespace: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'namespaced-error-types.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(true);
  });

  it.each([
    'import type * as Types from "./data.ts"; function read(error: Types.Failure) { return error.stack; }',
    'import { Types } from "./data.ts"; function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { type Failure = { stack: string } } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { type Error = { stack: string }; type Failure = Error } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { type Error = { stack: string } } declare namespace Types { type Failure = Error } function read(error: Types.Failure) { return error.stack; }',
    'namespace Types { export type Error = { stack: string } } namespace Types { export type Failure = Error } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Imported { interface Data { stack: string } } declare namespace Types { export import Error = Imported.Data } declare namespace Types { type Failure = Error } function read(error: Types.Failure) { return error.stack; }',
    'namespace Types { type Base = Error } namespace Types { export type Failure = Base } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { interface Failure { stack: string } } function read(error: Types.Failure) { return error.stack; }',
    'namespace Types { type Failure = Error } function read(error: Types.Failure) { return error.stack; }',
    'namespace Types { namespace Nested { export type Failure = Error } } function read(error: Types.Nested.Failure) { return error.stack; }',
    'declare namespace Types { type Failure = Types.Loop; type Loop = Types.Failure } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { type Failure = Error } namespace Inner { export namespace Types { export type Failure = { stack: string } } export function read(error: Types.Failure) { return error.stack; } }',
    'declare namespace Types { type Failure = Error } namespace Inner { export namespace Types { export type Other = string } export function read(error: Types.Failure) { return error.stack; } }',
    'declare namespace Types { type Failure = Error } namespace Inner { enum Types { Failure } export function read(error: Types.Failure) { return error.stack; } }',
    'declare namespace Types { type Failure = Error } namespace Inner { import Types = Imported; export function read(error: Types.Failure) { return error.stack; } }',
    'function read(error: Unknown.Error) { return error.stack; }',
  ])('keeps imported, hidden and data members opaque: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'opaque-namespace-types.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(false);
  });
});

function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node)?.includes('reads `stack` of an error') === true) {
      return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
