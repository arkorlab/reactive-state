import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('the individual operands of a distributive error conditional', () => {
  it.each([
    'type Take<T> = T extends { error: infer U } ? U : never; function read(error: Take<{ error: Error } | { error: { stack: string } }>) { return error.stack; }',
    'type Take<T> = T extends [infer U] ? U : never; function read(error: Take<[Error] | [{ stack: string }]>) { return error.stack; }',
    'type Take<T> = T extends (infer U)[] ? U : never; function read(error: Take<Error[] | { stack: string }[]>) { return error.stack; }',
    'type Box<T> = { error: T }; type Take<T> = T extends { error: infer U } ? U : never; function read(error: Take<Box<Error> | Box<{ stack: string }>>) { return error.stack; }',
    'type Box<T> = [T]; type Take<T> = T extends [infer U] ? U : never; function read(error: Take<Box<Error> | Box<{ stack: string }>>) { return error.stack; }',
    'type Box<T> = T[]; type Take<T> = T extends (infer U)[] ? U : never; function read(error: Take<Box<Error> | Box<{ stack: string }>>) { return error.stack; }',
    'type Native = { error: Error }; type Data = { error: { stack: string } }; type Both = Native | Data; type Take<T> = T extends { error: infer U } ? U : never; function read(error: Take<Both>) { return error.stack; }',
    'type Take<T> = T extends { error: infer U } ? U : never; type Both = { error: Error } | never; function read(error: Take<Both>) { return error.stack; }',
    'type Same<T> = T; type Take<T> = Same<T> extends { error: infer U } ? U : never; function read(error: Take<{ error: Error } | { error: string }>) { return error.stack; }',
    'type Take<T> = T extends Error ? T : { stack: string }; function read(error: Take<Error | string>) { return error.stack; }',
    'type Take<T> = T extends never ? Error : { stack: string }; function read(error: Take<any>) { return error.stack; }',
    // A primitive's structural match stays unknown, retaining candidates of a nondistributive union.
    'type Take<T> = (T | string) extends { error: infer U } ? U : { stack: string }; function read(error: Take<{ error: Error }>) { return error.stack; }',
  ])('retains an error selected from a union member: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'type Take<T> = T extends { error: infer U } ? U : never; function read(error: Take<{ error: { stack: string } } | { error: { stack: string; other: number } }>) { return error.stack; }',
    'type Take<T> = T extends string ? T : { stack: string }; function read(error: Take<Error | string>) { return error.stack; }',
    'type Take<T> = T extends number ? T : { stack: string }; function read(error: Take<Error | number>) { return error.stack; }',
    'type Take<T> = T extends { kind: "data"; error: infer U } ? U : { stack: string }; function read(error: Take<{ kind: "native"; error: Error } | { kind: "data"; error: { stack: string } }>) { return error.stack; }',
    'type Box<T> = { error: T }; type Take<T> = T extends { error: infer U } ? U : never; function read(error: Take<Box<{ stack: string }> | Box<{ stack: string; other: number }>>) { return error.stack; }',
    'type Box<T> = { error: T }; type Take<T> = T extends { error: infer U } ? U : never; function within() { type Error = { stack: string }; function read(error: Take<Box<Error> | Box<string>>) { return error.stack; } }',
    'type Take<T> = T extends unknown ? Error : never; function read(error: Take<never>) { return error.stack; }',
    'type Same<T> = T; type Take<T> = Same<T> extends unknown ? Error : never; function read(error: Take<never>) { return error.stack; }',
    'type Loop = Loop; type Take<T> = T extends { error: infer U } ? U : never; function read(error: Take<Loop>) { return error.stack; }',
    'type Take<T> = T extends { error: infer U } ? U : never; function read(error: Take<{ other: Error } | { error: { stack: string } }>) { return error.stack; }',
    'type Take<T> = (T | { other: string }) extends { error: infer U } ? U : { stack: string }; function read(error: Take<{ error: Error }>) { return error.stack; }',
    'type Take<T> = T extends true ? { stack: string } : { stack: string }; function read(error: Take<boolean>) { return error.stack; }',
  ])('keeps unmatched errors, data and never out of the result: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });
});

function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'distributed-error-types.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (framedRead(at)?.includes('reads `stack` of an error') === true) return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
