import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('corresponding generic references in conditional inference', () => {
  it.each([
    'type Unwrap<T> = T extends Promise<infer U> ? U : never; function read(error: Unwrap<Promise<Error>>) { return error.stack; }',
    'type Unwrap<T> = T extends globalThis.Promise<infer U> ? U : never; function read(error: Unwrap<Promise<Error>>) { return error.stack; }',
    'type Unwrap<T> = T extends Promise<infer U> ? U : never; function read(error: Unwrap<globalThis.Promise<Error>>) { return error.stack; }',
    'type Later<T = Error> = Promise<T>; type Unwrap<T> = T extends Promise<infer U> ? U : never; function read(error: Unwrap<Later>) { return error.stack; }',
    'type Later<T> = Promise<T>; type Unwrap<T> = T extends Later<infer U> ? U : never; function read(error: Unwrap<Later<Error>>) { return error.stack; }',
    'type Unwrap<T> = T extends Promise<Promise<infer U>> ? U : never; function read(error: Unwrap<Promise<Promise<Error>>>) { return error.stack; }',
    'type Unwrap<T> = T extends Promise<infer U> ? U : never; function read<Promise>(error: Unwrap<globalThis.Promise<Error>>) { return error.stack; }',
    'namespace Types { export type Unwrap<T> = T extends Promise<infer U> ? U : never } function read(error: Types.Unwrap<Promise<Error>>) { return error.stack; }',
    'type Later<T = Error> = Promise<T>; type Unwrap<T> = T extends Promise<infer U> ? U : never; function within() { type Error = { stack: string }; function read(error: Unwrap<Later>) { return error.stack; } }',
    'type globalThis = { value: string }; type Unwrap<T> = T extends globalThis.Promise<infer U> ? U : never; function read(error: Unwrap<globalThis.Promise<Error>>) { return error.stack; }',
  ])('keeps each inferred argument in its declaration environment: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'type Unwrap<T> = T extends Promise<infer U> ? U : never; function read(error: Unwrap<Promise<{ stack: string }>>) { return error.stack; }',
    'type Later<T = { stack: string }> = Promise<T>; type Unwrap<T> = T extends Promise<infer U> ? U : never; function read(error: Unwrap<Later>) { return error.stack; }',
    'type Unwrap<T> = T extends Promise<infer U> ? U : never; function within() { type Error = { stack: string }; function read(error: Unwrap<Promise<Error>>) { return error.stack; } }',
    'type Promise<T> = { value: T }; type Unwrap<T> = T extends Promise<infer U> ? U : never; function read(error: Unwrap<globalThis.Promise<Error>>) { return error.stack; }',
    'import type { Promise } from "./data.ts"; type Unwrap<T> = T extends Promise<infer U> ? U : never; function read(error: Unwrap<globalThis.Promise<Error>>) { return error.stack; }',
    'declare namespace globalThis { class Promise<T> { value: T } } type Unwrap<T> = T extends globalThis.Promise<infer U> ? U : never; function read(error: Unwrap<Promise<Error>>) { return error.stack; }',
    'import type * as globalThis from "./data.ts"; type Unwrap<T> = T extends globalThis.Promise<infer U> ? U : never; function read(error: Unwrap<Promise<Error>>) { return error.stack; }',
    'type Unwrap<T> = T extends Promise<infer U> ? U : never; function read(error: Unwrap<Set<Error>>) { return error.stack; }',
    'class Cell<T> { value!: T } type Unwrap<T> = T extends Cell<infer U> ? U : never; function within() { class Cell<T> { data!: T } function read(error: Unwrap<Cell<Error>>) { return error.stack; } }',
  ])('preserves data and distinct lexical reference identities: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });
});

describe('fixed tuple positions around a rest pattern', () => {
  it.each([
    'type Head<T> = T extends [infer H, ...unknown[]] ? H : never; function read(error: Head<[Error]>) { return error.stack; }',
    'type Head<T> = T extends [infer H, ...unknown[]] ? H : never; function read(error: Head<[Error, string, number]>) { return error.stack; }',
    'type Last<T> = T extends [...unknown[], infer H] ? H : never; function read(error: Last<[Error]>) { return error.stack; }',
    'type Last<T> = T extends [string, ...unknown[], infer H] ? H : never; function read(error: Last<[string, boolean, Error]>) { return error.stack; }',
    'type Head<T> = T extends [head: infer H, ...tail: unknown[]] ? H : never; function read(error: Head<[first: Error]>) { return error.stack; }',
    'type Head<T> = T extends readonly [infer H, ...unknown[]] ? H : never; function read(error: Head<readonly [Error]>) { return error.stack; }',
    'type Head<T> = T extends [infer H, ...unknown[]] ? H : never; function read(error: Head<[Error, ...unknown[]]>) { return error.stack; }',
    'type Last<T> = T extends [...unknown[], infer H] ? H : never; function read(error: Last<[...unknown[], Error]>) { return error.stack; }',
    'type Args<T = Error> = [T]; type Head<T> = T extends [infer H, ...unknown[]] ? H : never; function read(error: Head<Args>) { return error.stack; }',
    'type Head<T> = T extends [infer H, ...string[]] ? H : never; function read(error: Head<[Error, string]>) { return error.stack; }',
  ])('retains guaranteed prefix and suffix candidates without shifting: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'type Head<T> = T extends [infer H, ...unknown[]] ? H : never; function read(error: Head<[{ stack: string }, Error]>) { return error.stack; }',
    'type Last<T> = T extends [...unknown[], infer H] ? H : never; function read(error: Last<[Error, { stack: string }]>) { return error.stack; }',
    'type Head<T> = T extends [infer H, ...unknown[]] ? H : { stack: string }; function read(error: Head<readonly [Error]>) { return error.stack; }',
    'type Head<T> = T extends [infer H, ...unknown[]] ? H : { stack: string }; function read(error: Head<[]>) { return error.stack; }',
    'type Head<T> = T extends [infer H, ...string[]] ? H : { stack: string }; function read(error: Head<[Error, number]>) { return error.stack; }',
    'type Head<T> = T extends [infer H, ...unknown[], string] ? H : { stack: string }; function read(error: Head<[Error, number]>) { return error.stack; }',
    'type Head<T> = T extends [infer H, ...unknown[]] ? H : { stack: string }; function read(error: Head<[Error?]>) { return error.stack; }',
    'type Head<T> = T extends [infer H, ...unknown[]] ? H : never; function read(error: Head<[...unknown[], Error]>) { return error.stack; }',
    'type Last<T> = T extends [...unknown[], infer H] ? H : never; function read(error: Last<[Error, ...unknown[]]>) { return error.stack; }',
    'type Head<T> = T extends [infer H, ...unknown[]] ? H : never; function within() { type Error = { stack: string }; function read(error: Head<[Error]>) { return error.stack; } }',
  ])(
    'keeps data, rejects failed requirements and leaves uncertain positions opaque: %s',
    (source) => {
      expect(readsFrames(source)).toBe(false);
    },
  );

  it.each([
    'type Wrapped<T> = T extends [infer H] ? Error : { stack: string }; function read(error: Wrapped<[Error, ...[]]>) { return error.stack; }',
    'type Wrapped<T> = T extends [infer H] ? Error : { stack: string }; function read(error: Wrapped<[...[Error]]>) { return error.stack; }',
    'type Tail<T = Error> = [T]; type Wrapped<T> = T extends [infer H] ? H : never; function read(error: Wrapped<[...Tail]>) { return error.stack; }',
    'type Args<T extends unknown[]> = [...T]; type Wrapped<T> = T extends [infer H] ? H : never; function read(error: Wrapped<Args<Args<[Error]>>>) { return error.stack; }',
    'type Head<T> = T extends [infer H, ...unknown[]] ? H : never; function read(error: Head<[...[], Error, ...unknown[]]>) { return error.stack; }',
    'type One<T> = [T]; type Wrapped<T> = T extends [...One<infer H>] ? H : never; function read(error: Wrapped<[Error]>) { return error.stack; }',
  ])('expands finite tuple rests before matching fixed positions: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'type Wrapped<T> = T extends [infer H] ? { stack: string } : Error; function read(error: Wrapped<[Error, ...[]]>) { return error.stack; }',
    'type Wrapped<T> = T extends [infer H] ? { stack: string } : Error; function read(error: Wrapped<[...[Error]]>) { return error.stack; }',
    'type Wrapped<T> = T extends [infer H, ...[]] ? H : { stack: string }; function read(error: Wrapped<[Error, string]>) { return error.stack; }',
  ])('keeps finite rest length requirements and the selected data branch: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });

  it.each([
    'type Wrapped<T> = T extends [infer H] ? H : never; function read<R extends unknown[]>(error: Wrapped<[Error, ...R]>) { return error.stack; }',
    'type Wrapped<T> = T extends [] ? Error : { stack: string }; function read<R extends unknown[]>(error: Wrapped<[...R]>) { return error.stack; }',
  ])('keeps possible finite matches of an unresolved generic rest: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it('rejects a fixed target shorter than the required prefix around an opaque rest', () => {
    expect(
      readsFrames(
        'type Wrapped<T> = T extends [infer H] ? Error : { stack: string }; function read<R extends unknown[]>(error: Wrapped<[Error, string, ...R]>) { return error.stack; }',
      ),
    ).toBe(false);
  });
});

/** Whether a declared value's type exposes engine error frames. */
function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'error-inference-references.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (framedRead(at) !== undefined) return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
