import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('missing function arguments and optional written positions', () => {
  it.each([
    'type Select<T> = T extends () => unknown ? { stack: string } : Error; function read(error: Select<(value: any) => void>) { return error.stack; }',
    'type Select<T> = T extends () => unknown ? { stack: string } : Error; function read(error: Select<(value: unknown) => void>) { return error.stack; }',
    'type Select<T> = T extends () => unknown ? { stack: string } : Error; function read(error: Select<(value: undefined) => void>) { return error.stack; }',
    'type Select<T> = T extends () => unknown ? { stack: string } : Error; function read(error: Select<(value: string | undefined) => void>) { return error.stack; }',
    'type Select<T> = T extends (first: string) => unknown ? { stack: string } : Error; function read(error: Select<(first: string, second: number | undefined) => void>) { return error.stack; }',
    'type Select<T> = T extends (first: string) => unknown ? { stack: string } : Error; function read(error: Select<(first: string, second: any) => void>) { return error.stack; }',
    'type Select<T> = T extends () => unknown ? { stack: string } : Error; function read(error: Select<(...values: [string | undefined]) => void>) { return error.stack; }',
    'type Select<T> = T extends (value?: string) => unknown ? Error : { stack: string }; function read(error: Select<(value: string | undefined) => void>) { return error.stack; }',
    'type Result<T> = T extends () => infer U ? U : never; function read(error: Result<(value?: string) => Error>) { return error.stack; }',
  ])('retains the actual error branch or compatible inferred result: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'type Select<T> = T extends () => unknown ? { stack: string } : Error; function read(data: Select<(value: void) => void>) { return data.stack; }',
    'type Select<T> = T extends () => unknown ? { stack: string } : Error; function read(data: Select<(value: string | void) => void>) { return data.stack; }',
    'type Select<T> = T extends (first: string) => unknown ? { stack: string } : Error; function read(data: Select<(first: string, second: void) => void>) { return data.stack; }',
    'type Result<T> = T extends (value?: string) => infer U ? U : Error; function read(data: Result<(value: string | undefined) => { stack: string }>) { return data.stack; }',
    'type Result<T> = T extends (value?: string) => infer U ? U : Error; function read(data: Result<(value: any) => { stack: string }>) { return data.stack; }',
    'type Result<T> = T extends (value?: string) => infer U ? U : Error; function read(data: Result<(value: unknown) => { stack: string }>) { return data.stack; }',
    'type Select<T> = T extends () => unknown ? { stack: string } : Error; function read(data: Select<(value?: string) => void>) { return data.stack; }',
    'type Result<T> = T extends (value?: string) => infer U ? U : { stack: string }; function read(data: Result<(value: string) => Error>) { return data.stack; }',
    'type Select<T> = T extends () => unknown ? Error : { stack: string }; function read(data: Select<(value: any) => void>) { return data.stack; }',
  ])(
    'preserves void omission and compatible optional data without the false branch: %s',
    (source) => {
      expect(readsFrames(source)).toBe(false);
    },
  );
});

/** Whether a declared result exposes a native error's engine frames. */
function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'function-arity.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node)?.includes('reads `stack` of an error') === true) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
