import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('boolean coverage in a conditional pattern union', () => {
  it.each([
    'type Wrapped<T> = T extends boolean | Error ? { stack: string } : Error; function read(error: Wrapped<boolean>) { return error.stack; }',
    'type Wrapped<T> = T extends Error | boolean ? { stack: string } : Error; function read(error: Wrapped<boolean>) { return error.stack; }',
    'type Choice = boolean | Error; type Wrapped<T> = T extends Choice ? { stack: string } : Error; function read(error: Wrapped<boolean>) { return error.stack; }',
    'type Choice<T = boolean> = T; type Wrapped<T> = T extends Choice | Error ? { stack: string } : Error; function read(error: Wrapped<boolean>) { return error.stack; }',
    'type Wrapped<T> = [T] extends [true | Error | false] ? { stack: string } : Error; function read(error: Wrapped<boolean>) { return error.stack; }',
    'type Yes = true; type No = false; type Wrapped<T> = [T] extends [Yes | Error | No] ? { stack: string } : Error; function read(error: Wrapped<boolean>) { return error.stack; }',
  ])('keeps data when the union covers both boolean values: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });

  it.each([
    'type Wrapped<T> = T extends boolean | Error ? Error : { stack: string }; function read(error: Wrapped<boolean>) { return error.stack; }',
    'type Wrapped<T> = T extends true | Error ? { stack: string } : Error; function read(error: Wrapped<boolean>) { return error.stack; }',
    'type Wrapped<T> = T extends string | number ? { stack: string } : Error; function read(error: Wrapped<boolean>) { return error.stack; }',
  ])('retains possible errors when boolean coverage does not select data: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });
});

describe('native array references in conditional inference', () => {
  it.each([
    'type Element<T> = T extends Array<infer U> ? U : never; function read(error: Element<Error[]>) { return error.stack; }',
    'type Element<T> = T extends ReadonlyArray<infer U> ? U : never; function read(error: Element<readonly Error[]>) { return error.stack; }',
    'type Element<T> = T extends Array<infer U> ? U : never; function read(error: Element<Array<Error>>) { return error.stack; }',
    'type Element<T> = T extends ReadonlyArray<infer U> ? U : never; function read(error: Element<ReadonlyArray<Error>>) { return error.stack; }',
    'type Element<T> = T extends (infer U)[] ? U : never; function read(error: Element<Array<Error>>) { return error.stack; }',
    'type Element<T> = T extends ReadonlyArray<infer U> ? U : never; function read(error: Element<[Error, { stack: string }]>) { return error.stack; }',
    'type Values<T = Error> = Array<T>; type Element<T> = T extends ReadonlyArray<infer U> ? U : never; function read(error: Element<Values>) { return error.stack; }',
    'type Element<T> = T extends Array<infer U> ? U : never; function read<Array>(error: Element<Error[]>) { return error.stack; }',
    'declare namespace Types { type Element<T> = T extends ReadonlyArray<infer U> ? U : never } function read(error: Types.Element<Error[]>) { return error.stack; }',
    'type Element<T> = T extends globalThis.Array<infer U> ? U : never; function read(error: Element<Error[]>) { return error.stack; }',
    'type Element<T> = T extends globalThis.ReadonlyArray<infer U> ? U : never; function read(error: Element<readonly Error[]>) { return error.stack; }',
    'type globalThis = { data: string }; type Element<T> = T extends globalThis.Array<infer U> ? U : never; function read(error: Element<globalThis.Array<Error>>) { return error.stack; }',
  ])('retains the inferred native element in its original environment: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'type Element<T> = T extends Array<infer U> ? U : never; function read(error: Element<{ stack: string }[]>) { return error.stack; }',
    'type Element<T> = T extends ReadonlyArray<infer U> ? U : never; function read(error: Element<readonly { stack: string }[]>) { return error.stack; }',
    'type Element<T> = T extends Array<infer U> ? U : { stack: string }; function read(error: Element<ReadonlyArray<Error>>) { return error.stack; }',
    'type Element<T> = T extends Array<infer U> ? U : { stack: string }; function read(error: Element<readonly Error[]>) { return error.stack; }',
    'type Array<T> = { value: T }; type Element<T> = T extends Array<infer U> ? U : never; function read(error: Element<Error[]>) { return error.stack; }',
    'type ReadonlyArray<T> = { value: T }; type Element<T> = T extends ReadonlyArray<infer U> ? U : never; function read(error: Element<Error[]>) { return error.stack; }',
    'import type { Array } from "./data.ts"; type Element<T> = T extends Array<infer U> ? U : never; function read(error: Element<Error[]>) { return error.stack; }',
    'import type Array from "./data.ts"; type Element<T> = T extends Array<infer U> ? U : never; function read(error: Element<Error[]>) { return error.stack; }',
    'import type * as Types from "./data.ts"; type Element<T> = T extends Types.Array<infer U> ? U : never; function read(error: Element<Error[]>) { return error.stack; }',
    'type Element<Array, T> = T extends Array<infer U> ? U : never; function read(error: Element<unknown, Error[]>) { return error.stack; }',
    'namespace Types { type Array<T> = { value: T }; export type Element<T> = T extends Array<infer U> ? U : never } function read(error: Types.Element<Error[]>) { return error.stack; }',
    'type Element<T> = T extends Array<infer Error> ? Error : never; function read(error: Element<{ stack: string }[]>) { return error.stack; }',
    'type Element<T> = T extends Array<infer U> ? U : never; function within() { type Error = { stack: string }; function read(error: Element<Error[]>) { return error.stack; } }',
    'declare namespace globalThis { type Array<T> = { value: T } } type Element<T> = T extends globalThis.Array<infer U> ? U : never; function read(error: Element<Error[]>) { return error.stack; }',
    'import type * as globalThis from "./data.ts"; type Element<T> = T extends globalThis.ReadonlyArray<infer U> ? U : never; function read(error: Element<Error[]>) { return error.stack; }',
  ])('preserves data, readonly direction and array-name shadows: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });
});

/** Whether a declared value's type exposes engine error frames. */
function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'error-pattern-followups.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (framedRead(at) !== undefined) return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
