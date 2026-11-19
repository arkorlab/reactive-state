import { type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('finite recursive error type transformations', () => {
  it.each([
    'type Wrapped<T> = T extends string ? Wrapped<Error> : T; function read(error: Wrapped<string>) { return error.stack; }',
    'type Wrapped<T> = T extends string ? Wrapped<Readonly<Error>> : T; function read(error: Wrapped<string>) { return error.stack; }',
    'type Wrapped<T> = T extends string ? Wrapped<Error> : T; type Outer<T> = Wrapped<T>; function read(error: Outer<string>) { return error.stack; }',
    'type Wrapped<T = string> = T extends string ? Wrapped<Error> : T; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped<T, U = T> = T extends string ? Wrapped<Error> : U; function read(error: Wrapped<string>) { return error.stack; }',
    'type Left<T> = T extends string ? Right<Error> : T; type Right<T> = Left<T>; function read(error: Left<string>) { return error.stack; }',
  ])('retains errors after a finite re-entry: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'type Wrapped<T> = T extends string ? Wrapped<{ stack: string }> : T; function read(error: Wrapped<string>) { return error.stack; }',
    'type Error = { stack: string }; type Wrapped<T> = T extends string ? Wrapped<Error> : T; function read(error: Wrapped<string>) { return error.stack; }',
    'type Loop<T> = Loop<T>; function read(error: Loop<Error>) { return error.stack; }',
    'type Loop<T> = Loop<T[]>; function read(error: Loop<Error>) { return error.stack; }',
    'type Loop<T> = Loop<{ value: T }>; function read(error: Loop<Error>) { return error.stack; }',
    'type Left<T> = Right<T>; type Right<T> = Left<T>; function read(error: Left<Error>) { return error.stack; }',
    'type Wrapped<T> = T extends string ? Wrapped<T> : { stack: string }; function read(error: Wrapped<string>) { return error.stack; }',
  ])('preserves data and terminates unresolved cycles: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });
});

function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'transformed-error-types.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (framedRead(at) !== undefined) return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
