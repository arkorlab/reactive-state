import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('conditional check operands with recursive aliases', () => {
  it('cuts a cycle reached while finding a naked conditional parameter', () => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'conditional-check-cycle.ts',
      'type Loop<T> = Loop<T> extends Promise<infer U> ? U : never; function read(value: Loop<Error>) { return value.stack; }',
    );

    expect(readsFrames(parsed.sourceFile)).toBe(false);
  });

  it('retains finite recursive conditional results with changed actual arguments', () => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'finite-conditional-check.ts',
      'type Value<T> = T extends Promise<infer U> ? Value<U> : T; function read(value: Value<Promise<Promise<Error>>>) { return value.stack; }',
    );

    expect(readsFrames(parsed.sourceFile)).toBe(true);
  });

  it('preserves data selected through composed conditional operands', () => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'conditional-check-data.ts',
      'type Value<T> = T extends { value: infer U } ? U : never; function read(value: Value<{ value: Promise<{ stack: string }> }> extends Promise<infer U> ? U : Error) { return value.stack; }',
    );

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
