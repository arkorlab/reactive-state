import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Written function signatures retain their selected result and parameter environments. */
describe('conditional function signature inference', () => {
  it.each([
    'type Result<T> = T extends (...args: any[]) => infer R ? R : never; function read(error: Result<() => Error>) { return error.stack; }',
    'type Result<T> = T extends (...args: any[]) => infer R ? R : never; function read(error: Result<(value: string) => Error>) { return error.stack; }',
    'type Source<T> = () => T; type Result<T> = T extends () => infer R ? R : never; function read(error: Result<Source<Error>>) { return error.stack; }',
    'type Source<T = Error> = () => T; type Result<T> = T extends () => infer R ? R : never; function read(error: Result<Source>) { return error.stack; }',
    'type Source<T> = () => T; type Result<T> = T extends () => infer R ? R : never; function read<Error>(error: Result<Source<globalThis.Error>>) { return error.stack; }',
    'declare namespace Types { type Source<T> = () => T; type Result<T> = T extends () => infer R ? R : never } function read(error: Types.Result<Types.Source<Error>>) { return error.stack; }',
    'type Result<T> = T extends (value: string) => infer R ? R : never; function read(error: Result<(value: string) => Error>) { return error.stack; }',
    'type Result<T> = T extends (value: string) => infer R ? R : never; function read(error: Result<() => Error>) { return error.stack; }',
    'type Result<T> = T extends (value: string) => infer R ? R : never; function read(error: Result<(value?: string) => Error>) { return error.stack; }',
    'type Result<T> = T extends () => infer R ? R : never; function read(error: Result<(value?: string) => Error>) { return error.stack; }',
    'type Result<T> = T extends (value: string, extra: number) => infer R ? R : never; function read(error: Result<(value: string) => Error>) { return error.stack; }',
    'type Result<T> = T extends (value: string) => infer R ? R : never; function read(error: Result<(...values: string[]) => Error>) { return error.stack; }',
    'type Result<T> = T extends (...values: string[]) => infer R ? R : never; function read(error: Result<(value: string) => Error>) { return error.stack; }',
    'type Result<T> = T extends (...values: string[]) => infer R ? R : never; function read(error: Result<(...values: string[]) => Error>) { return error.stack; }',
    'type Result<T> = T extends (...values: [string]) => infer R ? R : never; function read(error: Result<(value: string) => Error>) { return error.stack; }',
    'type Result<T> = T extends (value: string) => infer R ? R : never; function read(error: Result<(...values: [string]) => Error>) { return error.stack; }',
    'type Result<T> = T extends (value: "selected") => infer R ? R : never; function read(error: Result<(value: string) => Error>) { return error.stack; }',
    'type Result<T> = T extends () => Promise<infer R> ? R : never; function read(error: Result<() => Promise<Error>>) { return error.stack; }',
    'type Result<T> = T extends () => { value: infer R } ? R : never; function read(error: Result<() => { value: Error }>) { return error.stack; }',
    'type Argument<T> = T extends (value: infer P) => unknown ? P : never; function read(error: Argument<(value: Error) => void>) { return error.stack; }',
    'type Source<T> = (value: T) => void; type Argument<T> = T extends (value: infer P) => unknown ? P : never; function read(error: Argument<Source<Error>>) { return error.stack; }',
    'type Argument<T> = T extends (...values: (infer P)[]) => unknown ? P : never; function read(error: Argument<(...values: Error[]) => void>) { return error.stack; }',
  ])('retains a selected declared error: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'function-inferred-errors.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(true);
  });

  it.each([
    'type Result<T> = T extends (...args: any[]) => infer R ? R : never; function read(data: Result<() => { stack: string }>) { return data.stack; }',
    'type Result<T> = T extends (...args: any[]) => infer R ? R : Error; function read(data: Result<(value: string) => { stack: string }>) { return data.stack; }',
    'type Source<T> = () => T; type Result<T> = T extends () => infer R ? R : never; function read(data: Result<Source<{ stack: string }>>) { return data.stack; }',
    'type Source<T = { stack: string }> = () => T; type Result<T> = T extends () => infer R ? R : never; function read(data: Result<Source>) { return data.stack; }',
    'type Source<T> = () => T; type Result<T> = T extends () => infer R ? R : never; function within() { type Error = { stack: string }; function read(data: Result<Source<Error>>) { return data.stack; } }',
    'type Result<T> = T extends () => infer Error ? Error : never; function read(data: Result<() => { stack: string }>) { return data.stack; }',
    'type Result<T> = T extends () => infer R ? R : { stack: string }; function read(data: Result<(value: string) => Error>) { return data.stack; }',
    'type Result<T> = T extends (value?: string) => infer R ? R : { stack: string }; function read(data: Result<(value: string) => Error>) { return data.stack; }',
    'type Result<T> = T extends (value: string) => infer R ? R : { stack: string }; function read(data: Result<(value: string, extra: number) => Error>) { return data.stack; }',
    'type Result<T> = T extends (value: number) => infer R ? R : { stack: string }; function read(data: Result<(value: string) => Error>) { return data.stack; }',
    'type Result<T> = T extends (...values: unknown[]) => infer R ? R : { stack: string }; function read(data: Result<(value: string) => Error>) { return data.stack; }',
    'type Result<T> = T extends (...values: number[]) => infer R ? R : { stack: string }; function read(data: Result<(...values: string[]) => Error>) { return data.stack; }',
    'type Result<T> = T extends (...values: []) => infer R ? R : { stack: string }; function read(data: Result<(value: string) => Error>) { return data.stack; }',
    'type Result<T> = T extends (value: string) => infer R ? R : { stack: string }; function read(data: Result<(...values: [string, number]) => Error>) { return data.stack; }',
    'type Result<T> = T extends (value: string) => infer R ? R : { stack: string }; function read(data: Result<(value: "selected") => Error>) { return data.stack; }',
    'type Result<T> = T extends () => Promise<infer R> ? R : never; function read(data: Result<() => Promise<{ stack: string }>>) { return data.stack; }',
    'type Result<T> = T extends () => { value: infer R } ? R : never; function read(data: Result<() => { value: { stack: string }; unrelated: Error }>) { return data.stack; }',
    'type Argument<T> = T extends (value: infer P) => unknown ? P : never; function read(data: Argument<(value: { stack: string }) => Error>) { return data.stack; }',
    'type Argument<T> = T extends (...values: (infer P)[]) => unknown ? P : never; function read(data: Argument<(...values: { stack: string }[]) => Error>) { return data.stack; }',
    'type Result<T> = T extends () => infer R ? ((() => { stack: string }) extends (() => infer R) ? R : never) : never; function read(data: Result<() => Error>) { return data.stack; }',
  ])('preserves data and syntax-known incompatible signatures: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'function-inferred-data.ts', source);

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
