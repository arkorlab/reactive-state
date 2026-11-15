import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('the error bases a local interface declares', () => {
  it.each([
    'interface Failure extends Error {} function read(error: Failure) { return error.stack; }',
    'interface Failure extends TypeError {} function read(error: Failure) { return error.stack; }',
    'interface Failure extends DOMException {} function read(error: Failure) { return error.stack; }',
    'interface Base extends Error {} interface Failure extends Base {} function read(error: Failure) { return error.stack; }',
    'type Base = Error; interface Failure extends Base {} function read(error: Failure) { return error.stack; }',
    'type Base<T> = T; interface Failure extends Base<Error> {} function read(error: Failure) { return error.stack; }',
    'type Base<T = Error> = T; interface Failure extends Base {} function read(error: Failure) { return error.stack; }',
    'const Error = { stack: "data" }; interface Failure extends Error {} function read(error: Failure) { return error.stack; }',
    'interface Failure extends globalThis.Error {} function read(error: Failure) { return error.stack; }',
    'const globalThis = { Error: {} }; interface Failure extends globalThis.Error {} function read(error: Failure) { return error.stack; }',
    'interface globalThis {} interface Failure extends globalThis.Error {} function read(error: Failure) { return error.stack; }',
    'declare namespace Types { interface Base extends Error {} interface Failure extends Base {} } function read(error: Types.Failure) { return error.stack; }',
    'namespace Types { export interface Failure extends Error {} } function read(error: Types.Failure) { return error.stack; }',
    'declare namespace Types { interface Base extends Error {} } interface Failure extends Types.Base {} function read(error: Failure) { return error.stack; }',
    'interface Failure {} interface Failure extends Error {} function read(error: Failure) { return error.stack; }',
    'interface Failure extends Error {} interface Failure {} function read(error: Failure) { return error.stack; }',
    'declare namespace Types { interface Failure {} } declare namespace Types { interface Failure extends Error {} } function read(error: Types.Failure) { return error.stack; }',
    'switch (value) { case 0: interface Failure {} break; default: interface Failure extends Error {} function read(error: Failure) { return error.stack; } }',
    'interface Left extends Right {} interface Right extends Left, Error {} function read(error: Left) { return error.stack; }',
    'interface Failure<T = Error> extends Error {} function read(error: Failure<{ stack: string }>) { return error.stack; }',
    'interface Failure extends Error {} class Failure { stack = "data"; } function read(error: Failure) { return error.stack; }',
    'class Failure { stack = "data"; } interface Failure extends Error {} function read(error: Failure) { return error.stack; }',
  ])('retains a written native error base: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'interface-error-types.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(true);
  });

  it.each([
    'interface Failure { stack: string } function read(error: Failure) { return error.stack; }',
    'interface Base { stack: string } interface Failure extends Base {} function read(error: Failure) { return error.stack; }',
    'type Error = { stack: string }; interface Failure extends Error {} function read(error: Failure) { return error.stack; }',
    'type Base<T> = T; interface Failure extends Base<{ stack: string }> {} function read(error: Failure) { return error.stack; }',
    'import type { Error } from "./data.ts"; interface Failure extends Error {} function read(error: Failure) { return error.stack; }',
    'interface Failure extends Error {} function within() { interface Failure { stack: string } function read(error: Failure) { return error.stack; } }',
    'interface Failure extends Error {} function read<Failure extends { stack: string }>(error: Failure) { return error.stack; }',
    'interface Left extends Right {} interface Right extends Left {} function read(error: Left) { return error.stack; }',
    'declare namespace Types { interface Failure { stack: string } } function read(error: Types.Failure) { return error.stack; }',
    'import type * as Types from "./data.ts"; interface Failure extends Types.Error {} function read(error: Failure) { return error.stack; }',
    'namespace globalThis { export interface Error { stack: string } } interface Failure extends globalThis.Error {} function read(error: Failure) { return error.stack; }',
    'declare namespace Types { interface Failure extends Error {} } namespace Inner { export namespace Types { export interface Failure { stack: string } } function read(error: Types.Failure) { return error.stack; } }',
    'interface Base extends Error {} class Failure extends Base {} function read(error: Failure) { return error.stack; }',
  ])('preserves data, lexical shadows and value-space class bases: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'interface-data-types.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(false);
  });
});

/** Whether the source reads engine error frames, independently of unrelated global admission. */
function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (framedRead(at)?.includes('reads `stack` of an error') === true) return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
