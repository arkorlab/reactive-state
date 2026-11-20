import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('written index signatures in conditional inference', () => {
  it.each([
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(error: Value<{ [key: string]: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: number]: infer U } ? U : never; function read(error: Value<{ [key: number]: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: number]: infer U } ? U : never; function read(error: Value<{ [key: string]: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(error: Value<{ [key: number]: Error }>) { return error.stack; }',
    'type Bag<T = Error> = { readonly [key: string]: T }; type Value<T> = T extends { readonly [key: string]: infer U } ? U : never; function read(error: Value<Bag>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: { value: infer U } } ? U : never; function read(error: Value<{ [key: string]: { value: Error } }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(error: Value<{ first: Error; second: { stack: string } }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(error: Value<{ first?: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: number]: infer U } ? U : never; function read(error: Value<{ 1: Error; other: { stack: string } }>) { return error.stack; }',
    'type Value<T> = T extends { [key: number]: infer U } ? U : never; function read(error: Value<{ "-1.5": Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(error: Value<{ [key: number]: { stack: string }; other: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: number]: infer U } ? U : never; function read(error: Value<{ [key: string]: Error | { stack: string }; [key: number]: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(error: Value<{ [key: string]: Error | { stack: string }; [key: number]: { stack: string } }>) { return error.stack; }',
    'type Bag<T = Error> = { [key: string]: T }; type Value<T> = T extends { [key: string]: infer U } ? U : never; function within() { type Error = { stack: string }; function read(error: Value<Bag>) { return error.stack; } }',
    'type Value<T> = T extends { [key: string]: infer U extends Error } ? U : never; function read(error: Value<{ [key: string]: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(error: Value<{ [key: string]: Promise<Error> }> extends Promise<infer U> ? U : never) { return error.stack; }',
  ])('retains each selected error candidate in its original environment: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(error: Value<{ [key: string]: { stack: string } }>) { return error.stack; }',
    'type Value<T> = T extends { [key: number]: infer U } ? U : never; function read(error: Value<{ [key: number]: { stack: string } }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function within() { type Error = { stack: string }; function read(error: Value<{ [key: string]: Error }>) { return error.stack; } }',
    'type Value<T> = T extends { [key: number]: infer U } ? U : never; function read(error: Value<{ other: Error; 1: { stack: string } }>) { return error.stack; }',
    'type Value<T> = T extends { [key: number]: infer U } ? U : never; function read(error: Value<{ "01": Error; "1e2": Error; "": Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: number]: infer U } ? U : never; function read(error: Value<{ [key: string]: Error | { stack: string }; [key: number]: { stack: string } }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(error: Value<{ [key: string]: unknown; first: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: number]: infer U } ? U : never; function read(error: Value<{ [key: string]: unknown; 1: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: number]: infer U } ? U : never; function read(error: Value<{ [key: number]: unknown; 1: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(error: Value<{ [key: symbol]: Error; data: { stack: string } }>) { return error.stack; }',
    'type Value<T> = T extends { [key: number]: infer U } ? U : never; function read(error: Value<{ method(): Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(error: Value<{ method(): Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer U extends string } ? U : { stack: string }; function read(error: Value<{ [key: string]: Error }>) { return error.stack; }',
    'type Value<T> = T extends { fixed: infer U; [key: string]: unknown } ? U : never; function read(error: Value<{ fixed: { stack: string }; other: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer U } ? ({ [key: string]: { stack: string } } extends { [key: string]: infer U } ? U : never) : never; function read(error: Value<{ [key: string]: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: infer Error } ? Error : never; function read(error: Value<{ [key: string]: { stack: string } }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: unknown } ? { stack: string } : Error; function read(error: Value<{ [key: string]: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: number]: unknown } ? { stack: string } : Error; function read(error: Value<{ [key: number]: Error }>) { return error.stack; }',
    'type Value<T> = T extends { [key: string]: unknown } ? { stack: string } : Error; function read(error: Value<{}>) { return error.stack; }',
  ])('preserves data, index domains, signature precedence and inference scopes: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });
});

/** Whether a declared value's type exposes engine error frames. */
function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'error-index-patterns.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (framedRead(at) !== undefined) return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
