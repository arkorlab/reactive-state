import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Switch lexical bindings and function-scoped variables retain their actual value owner. */
describe('written error value binding scopes', () => {
  it.each([
    {
      name: 'switch error annotation',
      source:
        'function frames(flag: boolean) { switch (flag) { case true: const error: Error = new Error(); return error.stack; default: return ""; } }',
    },
    {
      name: 'switch selected member annotation',
      source:
        'function frames(flag: boolean) { switch (flag) { default: const box: { error: Error } = { error: new Error() }; return box.error.stack; } }',
    },
    {
      name: 'switch constant key shadows outer data',
      source:
        'const field = "data"; function frames(error: Error & { data: string }, flag: boolean) { switch (flag) { case true: const field = "stack"; return error[field]; default: return ""; } }',
    },
    {
      name: 'switch clauses share a constant key',
      source:
        'const field = "data"; function frames(error: Error & { data: string }, flag: number) { switch (flag) { case 0: const field = "stack"; case 1: return error[field]; default: return ""; } }',
    },
    {
      name: 'switch clauses share an annotated member',
      source:
        'function frames(flag: number) { switch (flag) { case 0: const box: { error: Error } = { error: new Error() }; case 1: return box.error.stack; default: return ""; } }',
    },
    {
      name: 'nested block var retains its annotated member',
      source:
        'function frames() { { var box: { error: Error } = { error: new Error() }; } return box.error.stack; }',
    },
    {
      name: 'loop var retains its annotated member after the loop',
      source:
        'function frames() { for (var box: { error: Error } = { error: new Error() }; false;) {} return box.error.stack; }',
    },
    {
      name: 'static block var retains its annotated member',
      source:
        'class Holder { static { { var box: { error: Error } = { error: new Error() }; } box.error.stack; } }',
    },
    {
      name: 'ordinary block error annotation',
      source:
        'function frames() { { const box: { error: Error } = { error: new Error() }; return box.error.stack; } }',
    },
    {
      name: 'nested function var does not hide an outer constant',
      source:
        'const field = "stack"; function frames(error: Error) { function inner() { { var field = "data"; } } return error[field]; }',
    },
    {
      name: 'nested arrow var does not hide an outer constant',
      source:
        'const field = "stack"; function frames(error: Error) { const inner = () => { { var field = "data"; } }; return error[field]; }',
    },
    {
      name: 'class static var does not hide an outer constant',
      source:
        'const field = "stack"; function frames(error: Error) { class Inner { static { var field = "data"; } } return error[field]; }',
    },
    {
      name: 'switch lexical name does not leak outside the switch',
      source:
        'const field = "stack"; function frames(error: Error, flag: boolean) { switch (flag) { default: const field = "data"; break; } return error[field]; }',
    },
    {
      name: 'inner block constant does not leak outside its block',
      source:
        'const field = "stack"; function frames(error: Error) { { const field = "data"; } return error[field]; }',
    },
  ])('retains the selected error observation: $name', ({ source }) => {
    expect(readsFrames(source)).toBe(true);
  });

  it.each([
    {
      name: 'switch ordinary data annotation',
      source:
        'function frames(flag: boolean) { switch (flag) { default: const box: { error: { stack: string } } = { error: { stack: "data" } }; return box.error.stack; } }',
    },
    {
      name: 'switch constant data key shadows outer stack',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }, flag: boolean) { switch (flag) { case true: const field = "data"; return error[field]; default: return ""; } }',
    },
    {
      name: 'switch clauses share a constant data key',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }, flag: number) { switch (flag) { case 0: const field = "data"; case 1: return error[field]; default: return ""; } }',
    },
    {
      name: 'nested var data key hides an outer stack key',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }) { { var field: "data" = "data"; } return error[field]; }',
    },
    {
      name: 'ordinary block constant shadows a stack key',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }) { { const field = "data"; return error[field]; } }',
    },
    {
      name: 'parameter shadows a stack key',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }, field: "data") { return error[field]; }',
    },
    {
      name: 'loop constant shadows a stack key',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }) { for (const field of ["data"] as const) return error[field]; }',
    },
    {
      name: 'loop binding shadows an annotated outer object',
      source:
        'function frames(box: { error: Error }) { for (const box of [{ error: { stack: "data" } }]) return box.error.stack; }',
    },
    {
      name: 'nested parameter retains its data annotation',
      source:
        'function outer(box: { error: Error }) { return function frames(box: { error: { stack: string } }) { return box.error.stack; }; }',
    },
  ])('keeps data and nearer value owners: $name', ({ source }) => {
    expect(readsFrames(source)).toBe(false);
  });

  it.each([
    {
      name: 'a var key is hoisted before its declaration',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }) { const value = error[field]; { var field = "data"; } return value; }',
    },
    {
      name: 'loop var key remains in the containing function',
      source:
        'const field = "stack"; function frames(error: Error & { data: string }) { for (var field = "data"; false;) {} return error[field]; }',
    },
    {
      name: 'static block var key stays in its static block',
      source:
        'const field = "stack"; class Holder { static { { var field = "data"; } const error: Error & { data: string } = Object.assign(new Error(), { data: "fixed" }); error[field]; } }',
    },
    {
      name: 'a function declaration shadows a constant key',
      source:
        'const field = "stack"; function frames(error: Error) { function field() {} return error[field]; }',
    },
    {
      name: 'a switch function shadows a constant key',
      source:
        'const field = "stack"; function frames(error: Error, flag: boolean) { switch (flag) { default: function field() {} return error[field]; } }',
    },
    {
      name: 'named expression function hides an outer constant key',
      source:
        'const field = "stack"; const frames = function field(error: Error) { return error[field]; };',
    },
    {
      name: 'named expression class hides an outer constant key',
      source:
        'const field = "stack"; const Holder = class field { static frames(error: Error) { return error[field]; } };',
    },
  ])('refuses an opaque key after preserving its value owner: $name', ({ source }) => {
    expect(readsFrames(source)).toBe(true);
  });

  // An explicitly stack-typed mutable key now retains the possible error frame read.
  it.each([
    'const field = "data"; function frames(error: Error & { data: string }) { { var field: "stack" = "stack"; } return error[field]; }',
    'function frames(error: Error) { { var field: "stack" = "stack"; } return error[field]; }',
  ])('refuses a mutable key whose declared value selects stack: %s', (source) => {
    expect(readsFrames(source)).toBe(true);
  });
});

/** A frame or engine-word observation in the original lexical syntax. */
function readsFrames(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'value-binding-scopes.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
