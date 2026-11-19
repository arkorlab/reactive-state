import { type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('declared error constraints and written object conditional operands', () => {
  it.each([
    'function read<T extends Error>(error: T) { return error.stack; }',
    'type Failure = Error; function read<T extends Failure>(error: T) { return error.stack; }',
    'function read<T extends Error, U extends T>(error: U) { return error.stack; }',
    'type Wrapped<T extends Error> = T; function read<T extends Error>(error: Wrapped<T>) { return error.stack; }',
    'function read<T extends Readonly<Error>>(error: T) { return error.stack; }',
    'function read<Error extends TypeError>(error: Error) { return error.stack; }',
    'function read<T extends Error | { stack: string }>(error: T) { return error.stack; }',
  ])('retains explicit error constraints: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'function read<T extends { stack: string }>(error: T) { return error.stack; }',
    'type Error = { stack: string }; function read<T extends Error>(error: T) { return error.stack; }',
    'function other<T extends Error>() {} function read<T extends { stack: string }>(error: T) { return error.stack; }',
    'type Wrapped<T extends Error> = T; function read(error: Wrapped<{ name: string; message: string; stack: string }>) { return error.stack; }',
    'function read<T extends U, U extends T>(error: T) { return error.stack; }',
    'function read<T extends T>(error: T) { return error.stack; }',
    'type Wrapped<T extends Error> = T extends unknown ? Error : never; function read(error: Wrapped<never>) { return error.stack; }',
  ])('keeps data constraints, actual arguments and cycles: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });

  it.each([
    'string[]',
    'readonly string[]',
    '[string]',
    'readonly [string]',
    'Array<string>',
    'ReadonlyArray<string>',
    '() => string',
    'new () => { stack: string }',
    "{ [K in 'key']: string }",
  ])('keeps a written object in its known branch: %s', (type) => {
    const source = `type Wrapped<T> = T extends object ? { stack: string } : Error; function read(error: Wrapped<${type}>) { return error.stack; }`;

    expect(readsFrames(source)).toBe(false);
  });
});

function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'constrained-error-types.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (framedRead(at) !== undefined) return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
