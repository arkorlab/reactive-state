import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('signed numeric literals in error conditionals', () => {
  it.each([
    'type Wrapped<T> = T extends number ? { stack: string } : Error; function read(error: Wrapped<-1>) { return error.stack; }',
    'type Wrapped<T> = T extends number ? { stack: string } : Error; function read(error: Wrapped<-1.25>) { return error.stack; }',
    'type Negative = -0x1; type Wrapped<T = Negative> = T extends number ? { stack: string } : Error; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped<T> = T extends number ? { stack: string } : Error; function read(error: Wrapped<-0>) { return error.stack; }',
    'type Wrapped<T> = T extends bigint ? { stack: string } : Error; function read(error: Wrapped<-1n>) { return error.stack; }',
  ])('selects a syntax-known numeric data result: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });

  it.each([
    'type Wrapped<T> = T extends number ? Error : { stack: string }; function read(error: Wrapped<-1>) { return error.stack; }',
    'type Wrapped<T> = T extends bigint ? Error : { stack: string }; function read(error: Wrapped<-1n>) { return error.stack; }',
    'type Wrapped<T> = T extends number ? { stack: string } : Error; function read(error: Wrapped<"-1">) { return error.stack; }',
    'type Wrapped<T> = T extends number ? { stack: string } : Error; function read(error: Wrapped<-1n>) { return error.stack; }',
  ])('preserves errors on the selected or differently typed result: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });
});

describe('structurally equivalent built-in error conditions', () => {
  it.each([
    ['TypeError', 'RangeError'],
    ['RangeError', 'TypeError'],
    ['Error', 'EvalError'],
    ['URIError', 'SyntaxError'],
    ['ReferenceError', 'Error'],
    ['AggregateError', 'RangeError'],
    ['DOMException', 'TypeError'],
  ])('selects data for %s checked against %s', (source, target) => {
    expect(
      readsFrames(
        `type Wrapped<T> = T extends ${target} ? { stack: string } : Error; function read(error: Wrapped<${source}>) { return error.stack; }`,
      ),
    ).toBe(false);
  });

  it.each([
    'type Wrapped<T> = T extends TypeError ? Error : { stack: string }; function read(error: Wrapped<RangeError>) { return error.stack; }',
    'type Wrapped<T> = T extends AggregateError ? { stack: string } : Error; function read(error: Wrapped<RangeError>) { return error.stack; }',
    'type Wrapped<T> = T extends DOMException ? { stack: string } : Error; function read(error: Wrapped<TypeError>) { return error.stack; }',
    'type TypeError = { application: true }; type Wrapped<T> = T extends TypeError ? { stack: string } : Error; function read(error: Wrapped<RangeError>) { return error.stack; }',
    'import type { RangeError } from "./data.ts"; type Wrapped<T> = T extends TypeError ? { stack: string } : Error; function read(error: Wrapped<RangeError>) { return error.stack; }',
  ])('retains distinct members, shadows and selected error results: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });
});

/** Whether a declared value's type exposes engine error frames. */
function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'error-conditional-values.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (framedRead(at) !== undefined) return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
