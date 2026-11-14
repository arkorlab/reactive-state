import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * An array a function is given is no array that each run of it makes: a recursive call passes the
 * same one on, and what a run writes after it reads is there for the run that called it. A function
 * that makes its own, by a variable it declares, is run once for each array.
 */
const SAFE = "values.join = () => 'fixed';";

const CASES = [
  {
    id: 'parameter-array-override-restored-by-the-recursive-call',
    source: `function frames(error: Error) { function read(values: Error[], pass: number): string { ${SAFE} if (pass < 1) read(values, pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read([error], 0); }`,
    typed: true,
    converts: true,
  },
  {
    id: 'parameter-array-override-without-a-recursive-call-pin',
    source: `function frames(error: Error) { function read(values: Error[], pass: number): string { ${SAFE} const text = String(values); values.join = Array.prototype.join; return text; } return read([error], 0); }`,
    typed: true,
    converts: false,
  },
  {
    id: 'rest-array-override-restored-by-the-recursive-call-pin',
    source: `function frames(error: Error) { function read(pass: number, ...values: Error[]): string { ${SAFE} if (pass < 1) read(pass + 1, ...values); const text = String(values); values.join = Array.prototype.join; return text; } return read(0, error); }`,
    typed: true,
    converts: false,
  },
  {
    id: 'rest-array-passed-on-by-name-is-a-copy-pin',
    source: `function frames(error: Error) { function read(pass: number, ...values: Error[]): string { ${SAFE} if (pass < 1) read(pass + 1, values[0]); const text = String(values); values.join = Array.prototype.join; return text; } return read(0, error); }`,
    typed: true,
    converts: false,
  },
  {
    id: 'array-a-function-makes-override-restored-by-the-recursive-call-pin',
    source: `function frames(error: Error) { function read(pass: number): string { const values = [error]; ${SAFE} if (pass < 1) read(pass + 1); const text = String(values); values.join = Array.prototype.join; return text; } return read(0); }`,
    typed: true,
    converts: false,
  },
] as const;

/** Whether a conversion of `values` to text finds the error, where the input is typed or not. */
function convertsError(root: Node, typed: boolean): boolean {
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: (value: Expression) => {
      const each = unwrapped(value);
      return typed && isIdentifier(each) && each.text === 'values';
    },
  };
  const pending = [root];
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

describe('arrays a function is given, and arrays it makes', () => {
  it.each(CASES)('$id', ({ source, typed, converts }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'x.ts', source);

    expect(convertsError(parsed.sourceFile, typed)).toBe(converts);
  });
});
