import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A function declared with overloads is one function: its name resolves to the first signature, and
 * a call of it from its implementation is a recursion, as one of a function without overloads is.
 */
const SAFE = "values.join = () => 'fixed';";

const CASES = [
  {
    id: 'overloaded-function-calls-itself',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string; function read(pass: number, extra?: number): string { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'function-with-two-signatures-calls-itself',
    source: `function frames(error: Error) { const values = [error]; function read(pass: string): string; function read(pass: number): string; function read(pass: unknown): string { ${SAFE} if (pass === 0) read('again'); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'overloaded-function-calls-itself-through-a-helper',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string; function read(pass: number, extra?: number): string { ${SAFE} if (pass < 1) again(pass); const text = String(values); values.join = Array.prototype.join; return text; } function again(pass: number) { read(pass + 1); } return read(0); }`,
    converts: true,
  },
  {
    id: 'overloaded-function-that-does-not-call-itself-refused',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string; function read(pass: number, extra?: number): string { ${SAFE} const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'overloaded-function-whose-name-a-local-takes-refused',
    source: `function frames(error: Error) { const values = [error]; function read(pass: number): string; function read(pass: number, extra?: number): string { ${SAFE} const read = (again: number) => ''; if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    converts: true,
  },
  {
    id: 'overloads-in-a-switch-case',
    source: `function frames(error: Error) { const values = [error]; switch (0) { case 0: function read(pass: number): string; function read(pass: number, extra?: number): string { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); } return ''; }`,
    converts: true,
  },
  {
    id: 'overloads-in-a-switch-default',
    source: `function frames(error: Error) { const values = [error]; switch (1) { default: function read(pass: number): string; function read(pass: number, extra?: number): string { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); } return ''; }`,
    converts: true,
  },
  {
    id: 'overloads-in-a-later-switch-case',
    source: `function frames(error: Error) { const values = [error]; switch (2) { case 1: break; case 2: function read(pass: number): string; function read(pass: number, extra?: number): string { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); } return ''; }`,
    converts: true,
  },
  {
    id: 'overloads-in-a-block',
    source: `function frames(error: Error) { const values = [error]; { function read(pass: number): string; function read(pass: number, extra?: number): string { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); } }`,
    converts: true,
  },
  {
    id: 'overloads-in-a-class-static-block',
    source: `declare const error: Error; const values: unknown[] = [error]; class Holder { static { function read(pass: number): string; function read(pass: number, extra?: number): string { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } read(0); } }`,
    converts: true,
  },
  {
    id: 'overloads-in-a-namespace',
    source: `declare const error: Error; const values: unknown[] = [error]; namespace Reader { export function read(pass: number): string; export function read(pass: number, extra?: number): string { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } }`,
    converts: true,
  },
  {
    id: 'overloads-exported',
    source: `declare const error: Error; const values: unknown[] = [error]; export function read(pass: number): string; export function read(pass: number, extra?: number): string { ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; }`,
    converts: true,
  },
  {
    id: 'switch-overloads-that-do-not-call-themselves-refused',
    source: `function frames(error: Error) { const values = [error]; switch (0) { case 0: function read(pass: number): string; function read(pass: number, extra?: number): string { ${SAFE} const text = String(values); values.join = Array.prototype.join; return text; } return read(0); } return ''; }`,
    converts: true,
  },
  {
    id: 'switch-overloads-whose-name-a-local-takes-refused',
    source: `function frames(error: Error) { const values = [error]; switch (0) { case 0: function read(pass: number): string; function read(pass: number, extra?: number): string { ${SAFE} const read = (again: number) => ''; if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); } return ''; }`,
    converts: true,
  },
] as const;

describe('a function declared with overloads', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'overloaded-recursion.ts', source);
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: () => false,
  };
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      framedArrayString(node.arguments[0], words, node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
