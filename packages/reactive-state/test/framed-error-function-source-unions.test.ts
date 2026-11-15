import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('explicit function parameter paths through source unions', () => {
  it.each([
    'type Argument<T> = T extends (value: { nested: infer U }) => unknown ? U : never; function read(error: Argument<(value: { nested: Error } | { nested: TypeError }) => void>) { return error.stack; }',
    'type Argument<T> = T extends (value: [infer U]) => unknown ? U : never; function read(error: Argument<(value: [Error] | [TypeError]) => void>) { return error.stack; }',
    'type Argument<T> = T extends (value: Promise<infer U>) => unknown ? U : never; function read(error: Argument<(value: Promise<Error> | Promise<TypeError>) => void>) { return error.stack; }',
    'type Argument<T> = T extends (value: (infer U)[]) => unknown ? U : never; function read(error: Argument<(value: Error[] | TypeError[]) => void>) { return error.stack; }',
    'type Source<T> = { nested: T } | { nested: { stack: string } }; type Argument<T> = T extends (value: { nested: infer U }) => unknown ? U : never; function read(error: Argument<(value: Source<Error>) => void>) { return error.stack; }',
    'type Source<T = Error> = { nested: T } | { nested: { stack: string } }; type Argument<T> = T extends (value: { nested: infer U }) => unknown ? U : never; function within() { type Error = { stack: string }; function read(error: Argument<(value: Source) => void>) { return error.stack; } }',
    'type Source = { nested: Source } | { nested: Error }; type Argument<T> = T extends (value: { nested: infer U }) => unknown ? U : never; function read(error: Argument<(value: Source) => void>) { return error.stack; }',
  ])('retains each explicitly selected native error and its argument environment: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'type Argument<T> = T extends (value: { nested: infer U }) => unknown ? U : never; function read(data: Argument<(value: { nested: { stack: string } } | { nested: { stack: number } }) => Error>) { return data.stack; }',
    'type Argument<T> = T extends (value: { nested: infer U }) => unknown ? U : never; function read(data: Argument<(value: { nested: { stack: string } } | { other: Error }) => void>) { return data.stack; }',
    'type Argument<T> = T extends (value: [infer U]) => unknown ? U : never; function read(data: Argument<(value: [{ stack: string }] | [{ stack: number }]) => Error>) { return data.stack; }',
    'type Argument<T> = T extends (value: Promise<infer U>) => unknown ? U : never; function read(data: Argument<(value: Promise<{ stack: string }> | Promise<{ stack: number }>) => Error>) { return data.stack; }',
    'type Source<T> = { nested: T } | { nested: { stack: string } }; type Argument<T> = T extends (value: { nested: infer U }) => unknown ? U : never; function within() { type Error = { stack: string }; function read(data: Argument<(value: Source<Error>) => void>) { return data.stack; } }',
    'type Source = { nested: Source } | { nested: { stack: string } }; type Argument<T> = T extends (value: { nested: infer U }) => unknown ? U : never; function read(data: Argument<(value: Source) => void>) { return data.stack; }',
  ])('preserves selected data, unrelated fields and finite cyclic syntax: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });
});

/** Whether the source's selected type exposes a native error's engine frames. */
function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'function-source-union.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node)?.includes('reads `stack` of an error') === true) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
