import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString, framedArrayText } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Any function may run itself again: a write in the body of a loop that an exit follows leaves
 * the loop on the first pass, but the function around the loop may be run again before it ends,
 * by a name, a property, a getter, a decorator or a wait the compile does not follow, and what the
 * write left reaches the read of the next run. Where the array is one each run of that function
 * makes, the next run has an array of its own, and the loop is as it was.
 */
const CASES = [
  {
    id: 'declaration-that-never-calls-itself-refused',
    source:
      "function frames(error: Error) { const values: unknown[] = ['fixed']; function fill(): number { while (String(values)) { values[0] = error; return 1; } return 0; } fill(); }",
    converts: true,
  },
  {
    id: 'arrow-held-by-a-constant-refused',
    source:
      "function frames(error: Error) { const values: unknown[] = ['fixed']; const fill = (): number => { while (String(values)) { values[0] = error; return 1; } return 0; }; fill(); }",
    converts: true,
  },
  {
    id: 'function-expression-held-by-a-constant-refused',
    source:
      "function frames(error: Error) { const values: unknown[] = ['fixed']; const fill = function (): number { while (String(values)) { values[0] = error; return 1; } return 0; }; fill(); }",
    converts: true,
  },
  {
    id: 'immediate-function-refused',
    source:
      "function frames(error: Error) { const values: unknown[] = ['fixed']; (function (): number { while (String(values)) { values[0] = error; return 1; } return 0; })(); }",
    converts: true,
  },
  {
    id: 'arrow-handed-to-a-call-refused',
    source:
      "function frames(error: Error) { const values: unknown[] = ['fixed']; [0].forEach(() => { while (String(values)) { values[0] = error; return; } }); }",
    converts: true,
  },
  {
    id: 'async-function-refused',
    source:
      "function frames(error: Error) { const values: unknown[] = ['fixed']; async function fill(): Promise<number> { while (String(values)) { values[0] = error; return 1; } return 0; } void fill(); }",
    converts: true,
  },
  {
    id: 'function-nested-in-another-refused',
    source:
      "function frames(error: Error) { const values: unknown[] = ['fixed']; function outer(): void { function fill(): number { while (String(values)) { values[0] = error; return 1; } return 0; } fill(); } outer(); }",
    converts: true,
  },
  {
    id: 'function-of-a-name-the-body-reads-as-a-parameter-refused',
    source:
      "function frames(error: Error) { const values: unknown[] = ['fixed']; function fill(fill: () => number): number { while (String(values)) { values[0] = error; return fill(); } return 0; } fill(() => 1); }",
    converts: true,
  },
  {
    id: 'array-made-by-the-function-pin',
    source:
      "function frames(error: Error) { function fill(): number { const values: unknown[] = ['fixed']; while (String(values)) { values[0] = error; return 1; } return 0; } fill(); }",
    converts: false,
  },
  {
    id: 'array-made-by-the-function-around-pin',
    source:
      "function frames(error: Error) { const values: unknown[] = ['fixed']; while (String(values)) { values[0] = error; return 1; } return 0; }",
    converts: false,
  },
  {
    id: 'array-made-by-an-immediate-function-pin',
    source:
      "function frames(error: Error) { (function (): number { const values: unknown[] = ['fixed']; while (String(values)) { values[0] = error; return 1; } return 0; })(); }",
    converts: false,
  },
  {
    id: 'write-of-another-array-pin',
    source:
      "function frames(error: Error) { const values: unknown[] = ['fixed']; const others: unknown[] = []; function fill(): number { while (String(values)) { others[0] = error; return 1; } return 0; } fill(); }",
    converts: false,
  },
] as const;

describe('a function around a loop that an exit follows a write in', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'recursion-any-function.ts', source);

    expect(convertsError(parsed.sourceFile)).toBe(converts);
  });
});

/** Whether a native join, toString, sort or String call in the source converts `error`. */
function convertsError(root: Node): boolean {
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: () => false,
  };
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedArrayText(node, words)) return true;
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
