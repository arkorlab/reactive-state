import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** A uniquely selected conditional operand retains its own inferred argument environment. */
describe('conditional results used as later conditional operands', () => {
  it.each([
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(error: Value<{ [key: string]: Promise<Error> }> extends Promise<infer U> ? U : never) { return error.stack; }',
    'type Value<T> = T extends { value: infer U } ? U : never; type Result<T> = Value<T> extends Promise<infer U> ? U : never; function read(error: Result<{ value: Promise<Error> }>) { return error.stack; }',
    'type Value<T> = T extends { value: infer U } ? U : never; type Result<T> = Value<T> extends () => infer U ? U : never; function read(error: Result<{ value: () => Error }>) { return error.stack; }',
    'function read(error: (true extends true ? Promise<Error> : Promise<{ stack: string }>) extends Promise<infer U> ? U : never) { return error.stack; }',
    'type Value<T> = T extends string ? Promise<{ stack: string }> : Promise<Error>; function read(error: Value<number> extends Promise<infer U> ? U : never) { return error.stack; }',
    'type Value<T> = T extends string ? Promise<Error> : Promise<{ stack: string }>; function read<Error>(error: Value<"selected"> extends Promise<infer U> ? U : never) { return error.stack; }',
    'type Value<T = Error> = true extends true ? Promise<T> : never; function read<Error>(error: Value extends Promise<infer U> ? U : never) { return error.stack; }',
    'type Value<T> = T extends true ? Promise<Error> | Promise<{ stack: string }> : never; function read(error: Value<true> extends Promise<infer U> ? U : never) { return error.stack; }',
  ])('retains a declared error selected through a conditional result: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'conditional-operand-error.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(true);
  });

  it.each([
    'type Value<T> = T extends { [key: string]: infer U } ? U : never; function read(data: Value<{ [key: string]: Promise<{ stack: string }> }> extends Promise<infer U> ? U : never) { return data.stack; }',
    'type Value<T> = T extends string ? Promise<{ stack: string }> : Promise<Error>; function read(data: Value<"selected"> extends Promise<infer U> ? U : Error) { return data.stack; }',
    'type Value<T = { stack: string }> = true extends true ? Promise<T> : never; function read(data: Value extends Promise<infer U> ? U : never) { return data.stack; }',
    'type Value<T> = T extends { value: infer U } ? U : never; type Result<T> = Value<T> extends Promise<infer U> ? U : never; function within() { type Error = { stack: string }; function read(data: Result<{ value: Promise<Error> }>) { return data.stack; } }',
    'type Value<T> = T extends { value: infer U } ? U : never; function read(data: Value<{ value: Promise<Error> }> extends Promise<infer U> ? ({ value: { stack: string } } extends { value: infer U } ? U : never) : never) { return data.stack; }',
    'type Value<T> = T extends string ? Promise<Error> : number; function read(data: Value<string | number> extends Promise<infer U> ? U : { stack: string }) { return data.stack; }',
    'type Value<T> = T extends string ? Promise<{ stack: string }> : Promise<{ stack: number }>; function read<T>(data: Value<T> extends Promise<infer U> ? U : never) { return data.stack; }',
    'type Loop<T> = T extends string ? Loop<T> : Promise<Error>; function read(data: Loop<string> extends Promise<infer U> ? U : never) { return data.stack; }',
  ])('preserves data, separate inference scopes and unresolved alternatives: %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'conditional-operand-data.ts', source);

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
