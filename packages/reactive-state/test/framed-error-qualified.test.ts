import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('the native error types a shared module qualifies through globalThis', () => {
  it.each([
    'function read(error: globalThis.Error) { return error.stack; }',
    'function read(error: globalThis.AggregateError) { return error.stack; }',
    'function read(error: globalThis.DOMException) { return error.stack; }',
    'function read(error: globalThis.EvalError) { return error.stack; }',
    'function read(error: globalThis.RangeError) { return error.stack; }',
    'function read(error: globalThis.ReferenceError) { return error.stack; }',
    'function read(error: globalThis.SyntaxError) { return error.stack; }',
    'function read(error: globalThis.TypeError) { return error.stack; }',
    'function read(error: globalThis.URIError) { return error.stack; }',
    'function read(error: globalThis.globalThis.Error) { return error.stack; }',
    'function read(error: globalThis.globalThis.globalThis.TypeError) { return error.stack; }',
    'type Failure = globalThis.Error; function read(error: Failure) { return error.stack; }',
    'type Failure<T> = T; function read(error: Failure<globalThis.Error>) { return error.stack; }',
    'type Failure<T = globalThis.Error> = T; function read(error: Failure) { return error.stack; }',
    'type Error = { stack: string }; function read(error: globalThis.Error) { return error.stack; }',
    'const globalThis = {}; function read(error: globalThis.Error) { return error.stack; }',
    'class globalThis {} function read(error: globalThis.Error) { return error.stack; }',
    'type globalThis = string; function read(error: globalThis.Error) { return error.stack; }',
    'interface globalThis {} function read(error: globalThis.Error) { return error.stack; }',
    'function read<globalThis>(error: globalThis.Error) { return error.stack; }',
    'function read(globalThis: unknown, error: globalThis.Error) { return error.stack; }',
    'namespace Local { export function read(error: globalThis.Error) { return error.stack; } }',
    'declare namespace globalThis { type Failure = Error } function read(error: globalThis.Failure) { return error.stack; }',
  ])('reads frames of the qualified native error: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'qualified-error-types.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(true);
  });

  it.each([
    'function read(error: Unknown.Error) { return error.stack; }',
    'function read(error: global.Error) { return error.stack; }',
    'function read(error: window.Error) { return error.stack; }',
    'function read(error: self.Error) { return error.stack; }',
    'function read(error: globalThis.window.Error) { return error.stack; }',
    'function read(error: globalThis.self.Error) { return error.stack; }',
    'function read(error: globalThis.Unknown.Error) { return error.stack; }',
    'function read(error: globalThis.Object) { return error.stack; }',
    'function read(error: { stack: string; error: globalThis.Error }) { return error.stack; }',
    'import type * as globalThis from "./data.ts"; function read(error: globalThis.Error) { return error.stack; }',
    'import * as globalThis from "./data.ts"; function read(error: globalThis.globalThis.Error) { return error.stack; }',
    'import { Types as globalThis } from "./data.ts"; function read(error: globalThis.Error) { return error.stack; }',
    'import globalThis from "./data.ts"; function read(error: globalThis.Error) { return error.stack; }',
    'import globalThis = Types; function read(error: globalThis.Error) { return error.stack; }',
    'enum globalThis {} function read(error: globalThis.Error) { return error.stack; }',
    'declare namespace globalThis { type Error = { stack: string } } function read(error: globalThis.Error) { return error.stack; }',
    'declare namespace globalThis { type Other = string } function read(error: globalThis.Error) { return error.stack; }',
    'declare namespace globalThis { const Error: unknown } function read(error: globalThis.Error) { return error.stack; }',
    'namespace globalThis { type Error = globalThis.Error } function read(error: globalThis.Error) { return error.stack; }',
    'namespace Local { export namespace globalThis { export type Other = string } export function read(error: globalThis.Error) { return error.stack; } }',
    'namespace Local { export namespace globalThis { export type Other = string } } namespace Local { export function read(error: globalThis.Error) { return error.stack; } }',
    'namespace Local { namespace globalThis { export type Other = string } export function read(error: globalThis.globalThis.Error) { return error.stack; } }',
    'namespace Local.globalThis { export type Error = { stack: string }; export function read(error: globalThis.Error) { return error.stack; } }',
    'namespace Local.globalThis { export type Other = string; export function read(error: globalThis.Error) { return error.stack; } }',
  ])('keeps other holders and namespace bindings opaque: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'opaque-qualified-types.ts', source);

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
