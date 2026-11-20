import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('explicit function parameter inference paths', () => {
  it.each([
    'type Result<T> = T extends (value?: string) => infer U ? U : { stack: string }; function read(error: Result<(value: string | undefined) => Error>) { return error.stack; }',
    'type Argument<T> = T extends (value: { nested: infer U }) => unknown ? U : never; function read(error: Argument<(value: { nested: Error }) => void>) { return error.stack; }',
    'type Argument<T> = T extends (value: { kind: "selected"; nested: infer U }) => unknown ? U : never; function read(error: Argument<(value: { kind: string; nested: Error }) => void>) { return error.stack; }',
    'type Argument<T> = T extends (value: { nested: { value: infer U } }) => unknown ? U : never; function read(error: Argument<(value: { nested: { value: Error } }) => void>) { return error.stack; }',
    'type Argument<T> = T extends (value: [infer U]) => unknown ? U : never; function read(error: Argument<(value: [Error]) => void>) { return error.stack; }',
    'type Argument<T> = T extends (value: Promise<infer U>) => unknown ? U : never; function read(error: Argument<(value: Promise<Error>) => void>) { return error.stack; }',
  ])('retains an explicitly selected error parameter: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'function-parameter-error.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(true);
  });

  it.each([
    'type Result<T> = T extends (value?: string) => infer U ? U : never; function read(data: Result<(value: string | undefined) => { stack: string }>) { return data.stack; }',
    'type Argument<T> = T extends (value: { nested: infer U }) => unknown ? U : never; function read(data: Argument<(value: { nested: { stack: string } }) => Error>) { return data.stack; }',
    'type Argument<T> = T extends (value: { kind: "selected"; nested: infer U }) => unknown ? U : never; function read(data: Argument<(value: { kind: string; nested: { stack: string } }) => void>) { return data.stack; }',
    'type Argument<T> = T extends (value: { nested: infer U }) => unknown ? U : never; function read(data: Argument<(value: { other: Error }) => void>) { return data.stack; }',
    'type Argument<T> = T extends (value: [infer U]) => unknown ? U : never; function read(data: Argument<(value: [{ stack: string }]) => Error>) { return data.stack; }',
    'type Argument<T> = T extends (value: Promise<infer U>) => unknown ? U : never; function read(data: Argument<(value: Promise<{ stack: string }>) => Error>) { return data.stack; }',
  ])('preserves selected data and missing or unrelated fields: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'function-parameter-data.ts', source);

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
