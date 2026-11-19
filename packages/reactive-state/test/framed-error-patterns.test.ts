import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Explicit error types selected by a written conditional inference pattern. */
describe('the nested type patterns a conditional infers', () => {
  it.each([
    'type Wrapped<T> = T extends { value: infer Inferred } ? Inferred : never; function read(error: Wrapped<{ value: Error }>) { return error.stack; }',
    'type Wrapped<T> = T extends { box: { value: infer Inferred } } ? Inferred : never; function read(error: Wrapped<{ box: { value: Error } }>) { return error.stack; }',
    'type Wrapped<T> = T extends [infer Inferred] ? Inferred : never; function read(error: Wrapped<[Error]>) { return error.stack; }',
    'type Wrapped<T> = T extends readonly [string, [infer Inferred]] ? Inferred : never; function read(error: Wrapped<["data", [Error]]>) { return error.stack; }',
    'type Wrapped<T> = T extends (infer Inferred)[] ? Inferred : never; function read(error: Wrapped<Error[]>) { return error.stack; }',
    'type Wrapped<T> = T extends readonly (infer Inferred)[] ? Inferred : never; function read(error: Wrapped<readonly Error[]>) { return error.stack; }',
    'type Box<T> = { value: T }; type Wrapped<T> = T extends Box<infer Inferred> ? Inferred : never; function read(error: Wrapped<Box<Error>>) { return error.stack; }',
    'type Box<T = Error> = { value: T }; type Wrapped<T> = T extends Box<infer Inferred> ? Inferred : never; function read(error: Wrapped<Box>) { return error.stack; }',
    'type Box = { value: Error }; type Wrapped<T> = T extends { value: infer Inferred } ? Inferred : never; function read<Error>(error: Wrapped<Box>) { return error.stack; }',
    'declare namespace Types { type Box<T> = { value: T } } type Wrapped<T> = T extends Types.Box<infer Inferred> ? Inferred : never; function read(error: Wrapped<Types.Box<Error>>) { return error.stack; }',
    'type Wrapped<T> = T extends { value: infer Inferred extends Error } ? Inferred : never; function read(error: Wrapped<{ value: Error }>) { return error.stack; }',
    'type Wrapped<T> = T extends { left: infer Inferred; right: infer Inferred } ? Inferred : never; function read(error: Wrapped<{ left: Error; right: { stack: string } }>) { return error.stack; }',
    'type Wrapped<T> = T extends { left: infer Inferred; right: infer Inferred } ? Inferred : never; function read(error: Wrapped<{ left: { stack: string }; right: Error }>) { return error.stack; }',
    'type Wrapped<T> = T extends [infer Inferred, infer Inferred] ? Inferred : never; function read(error: Wrapped<[{ stack: string }, Error]>) { return error.stack; }',
    'type Wrapped<T> = T extends (infer Inferred)[] ? Inferred : never; function read(error: Wrapped<[{ stack: string }, Error]>) { return error.stack; }',
    'type Wrapped<T> = T extends [value: infer Inferred] ? Inferred : never; function read(error: Wrapped<[value: Error]>) { return error.stack; }',
    'type Wrapped<T> = T extends { value: infer Inferred } ? Inferred : Error; function read(error: Wrapped<{ value?: string }>) { return error.stack; }',
    'type Wrapped<T> = [T] extends [{ value: infer Inferred }] ? Inferred : never; function read(error: Wrapped<{ value: Error } | { value: { stack: string } }>) { return error.stack; }',
    'type Wrapped<T> = T extends { left: infer Inferred } | { right: infer Inferred } ? Inferred : never; function read(error: Wrapped<{ right: Error }>) { return error.stack; }',
    'type Wrapped<T> = [T] extends [true | false] ? Error : { stack: string }; function read(error: Wrapped<boolean>) { return error.stack; }',
    'type Wrapped<T> = T extends { missing: infer Inferred } ? Inferred : Error; function read(error: Wrapped<{ value: string }>) { return error.stack; }',
  ])('retains an error selected by a known pattern: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'inferred-error-patterns.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(true);
  });

  it.each([
    'type Wrapped<T> = T extends { value: infer Inferred } ? Inferred : never; function read(error: Wrapped<{ value: { stack: string } }>) { return error.stack; }',
    'type Wrapped<T> = T extends { value: infer Inferred } ? Inferred : Error; function read(error: Wrapped<{ value: { stack: string } }>) { return error.stack; }',
    'type Wrapped<T> = T extends [infer Inferred] ? Inferred : Error; function read(error: Wrapped<[{ stack: string }]>) { return error.stack; }',
    'type Wrapped<T> = T extends { left: infer Inferred; right: infer Inferred } ? Inferred : Error; function read(error: Wrapped<{ left: { stack: string }; right: { stack: string } }>) { return error.stack; }',
    'type Wrapped<T> = T extends [infer Inferred, infer Inferred] ? Inferred : Error; function read(error: Wrapped<[{ stack: string }, { stack: string }]>) { return error.stack; }',
    'type Wrapped<T> = T extends [infer Inferred] ? Inferred : { stack: string }; function read(error: Wrapped<readonly [Error]>) { return error.stack; }',
    'type Wrapped<T> = [T] extends [{ value: infer Inferred }] ? { stack: string } : Error; function read(error: Wrapped<{ value: Error } | { value: { stack: string } }>) { return error.stack; }',
    'type Wrapped<T> = T extends { left: infer Inferred } | { right: infer Inferred } ? { stack: string } : Error; function read(error: Wrapped<{ right: Error }>) { return error.stack; }',
    'type Wrapped<T> = [T] extends [{ kind: "allowed"; value: infer Inferred }] ? Inferred : { stack: string }; function read(error: Wrapped<{ kind: "allowed"; value: Error } | { kind: "blocked"; value: Error }>) { return error.stack; }',
    'type Wrapped<T> = T extends { left: infer Inferred } | { right: infer Inferred } ? Inferred : { stack: string }; function read(error: Wrapped<{ other: Error }>) { return error.stack; }',
    'type Wrapped<T> = [T] extends [true | false] ? { stack: string } : Error; function read(error: Wrapped<boolean>) { return error.stack; }',
    'type Wrapped<T> = T extends { value: infer Inferred } ? Inferred : never; function read(error: Wrapped<{ value: { stack: string }; unrelated: Error }>) { return error.stack; }',
    'type Wrapped<T> = T extends { kind: "allowed"; value: infer Inferred } ? Inferred : never; function read(error: Wrapped<{ kind: "blocked"; value: Error }>) { return error.stack; }',
    'type Wrapped<T> = T extends { value: infer Inferred extends string } ? Inferred : { stack: string }; function read(error: Wrapped<{ value: Error }>) { return error.stack; }',
    'type Wrapped<T> = T extends { value: infer Inferred } ? ({ value: { stack: string } } extends { value: infer Inferred } ? Inferred : never) : never; function read(error: Wrapped<{ value: Error }>) { return error.stack; }',
    'type Wrapped<T> = T extends { value: infer Error } ? Error : never; function read(error: Wrapped<{ value: { stack: string } }>) { return error.stack; }',
    'type Wrapped<T> = T extends { value: infer Inferred } ? Inferred : never; function within() { type Error = { stack: string }; function read(error: Wrapped<{ value: Error }>) { return error.stack; } }',
    'type Loop = { value: Loop }; type Wrapped<T> = T extends { value: infer Inferred } ? Inferred : never; function read(error: Wrapped<Loop>) { return error.stack; }',
    'type Left<T> = Right<T>; type Right<T> = Left<T>; type Wrapped<T> = T extends Left<infer Inferred> ? Inferred : never; function read(error: Wrapped<{ value: Error }>) { return error.stack; }',
    'type Wrapped<T> = T extends [infer Inferred] ? Inferred : { stack: string }; function read(error: Wrapped<[Error, string]>) { return error.stack; }',
  ])('preserves data, unreachable error fields and inference scopes: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'inferred-data-patterns.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(false);
  });
});

function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node)?.includes('reads `stack` of an error') === true) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
