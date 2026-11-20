import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('explicit index signatures selected by literal keys', () => {
  it.each([
    'type Bag = { [key: string]: Error }; function read(error: Bag["failure"]) { return error.stack; }',
    'type Bag<T> = { [key: string]: T }; function read(error: Bag<Error>["failure"]) { return error.stack; }',
    'type Bag<T = Error> = { readonly [key: string]: T }; function read(error: Bag["failure"]) { return error.stack; }',
    'type Bag = { [key: number]: Error }; function read(error: Bag[1]) { return error.stack; }',
    'type Bag = { [key: number]: Error }; function read(error: Bag["1"]) { return error.stack; }',
    'type Bag = { [key: number]: Error }; function read(error: Bag[-1.5]) { return error.stack; }',
    'type Bag = { [key: string]: { data: Error } }; function read(error: Bag["failure"]["data"]) { return error.stack; }',
    'type Bag = { [key: string]: Error }; type Wrapped = Readonly<Bag>["failure"]; function read(error: Wrapped) { return error.stack; }',
  ])('retains the selected explicit error type: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    'type Bag = { [key: string]: { stack: string } }; function read(error: Bag["failure"]) { return error.stack; }',
    'type Bag<T> = { [key: string]: T }; function read(error: Bag<{ stack: string }>["failure"]) { return error.stack; }',
    'type Bag = { [key: number]: Error; data: { stack: string } }; function read(error: Bag["data"]) { return error.stack; }',
    'type Bag = { [key: number]: Error }; function read(error: Bag["01"]) { return error.stack; }',
    'type Bag = { [key: number]: Error }; function read(error: Bag["1e2"]) { return error.stack; }',
    'type Bag = { [key: symbol]: Error; data: { stack: string } }; function read(error: Bag["data"]) { return error.stack; }',
    'type Bag = { [key: string]: Error | { stack: string }; data: { stack: string } }; function read(error: Bag["data"]) { return error.stack; }',
    'type Bag = { [key: string]: Error | { stack: string }; [key: number]: { stack: string } }; function read(error: Bag[1]) { return error.stack; }',
    'type Error = { stack: string }; type Bag = { [key: string]: Error }; function read(error: Bag["failure"]) { return error.stack; }',
    'type Bag = { failure(): Error; [key: string]: Error | (() => Error) }; function read(error: Bag["failure"]) { return error.stack; }',
  ])('preserves explicit properties, numeric domains and application data: %s', (source) => {
    expect(readsFrames(source)).toBe(false);
  });
});

/** Whether a declared value's type exposes engine error frames. */
function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'error-index-signatures.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (framedRead(at) !== undefined) return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
