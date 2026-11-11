import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import {
  arrayMethodOverride,
  framedArrayString,
  framedArrayText,
} from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A call selects its method before it evaluates its arguments (ECMA-262, call evaluation): a write
 * of that method in the arguments is made after the selection, and what the call runs is the method
 * written before it. An assignment evaluates its right side before it writes, and a loop its
 * iterable before its head does: a read in either comes before the write. What the method itself
 * then reads, and a call's own repeats, still see it.
 */
const SAFE = "values.join = () => 'fixed';";

const CASES = [
  {
    id: 'reviewed-delete-argument',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return values.join(delete values.join); }`,
    converts: false,
  },
  {
    id: 'assignment-argument',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return values.join((values.join = Array.prototype.join, 1)); }`,
    converts: false,
  },
  {
    id: 'definition-argument',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return values.join(Object.defineProperty(values, 'join', { value: Array.prototype.join })); }`,
    converts: false,
  },
  {
    id: 'element-access-callee',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return values['join'](delete values.join); }`,
    converts: false,
  },
  {
    id: 'sort-argument',
    source: `function frames(error: Error) { const values = [error]; values.sort = () => values; return values.sort(delete values.sort); }`,
    converts: false,
  },
  {
    id: 'to-string-reads-join-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return values.toString(delete values.join); }`,
    converts: true,
  },
  {
    id: 'string-argument-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return String(values, delete values.join); }`,
    converts: true,
  },
  {
    id: 'operand-before-call-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return [delete values.join, values.join()][1]; }`,
    converts: true,
  },
  {
    id: 'other-method-argument-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return values.join(delete values.toString); }`,
    converts: false,
  },
  {
    id: 'loop-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} let text = ''; for (let pass = 0; pass < 2; pass++) text = values.join(delete values.join); return text; }`,
    converts: true,
  },
  {
    id: 'captured-array-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} function read() { return values.join(delete values.join); } return read() + read(); }`,
    converts: true,
  },
  {
    id: 'assignment-operand',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} values.join = String(values) as any; }`,
    converts: false,
  },
  {
    id: 'array-pattern-operand',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} [values.join] = [String(values) as any]; }`,
    converts: false,
  },
  {
    id: 'object-pattern-operand',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} ({ restore: values.join } = { restore: String(values) as any }); }`,
    converts: false,
  },
  {
    id: 'loop-iterable-operand',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (values.join of [String(values) as any]); }`,
    converts: false,
  },
  {
    id: 'later-target-default',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} [values.join, text = String(values)] = [Array.prototype.join, undefined]; }`,
    converts: true,
  },
  {
    id: 'later-computed-key',
    source: `function frames(error: Error, text: { [key: string]: unknown }) { const values = [error]; ${SAFE} ({ restore: values.join, [String(values)]: text.field } = { restore: Array.prototype.join }); }`,
    converts: true,
  },
  {
    id: 'earlier-default-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} [text = String(values), values.join] = [undefined, Array.prototype.join]; }`,
    converts: false,
  },
  {
    id: 'other-array-target-pin',
    source: `function frames(error: Error) { const values = [error]; const other = [1]; ${SAFE} [other.join, text = String(values)] = [Array.prototype.join, undefined]; }`,
    converts: false,
  },
  {
    id: 'repeated-assignment-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (let pass = 0; pass < 2; pass++) values.join = String(values) as any; }`,
    converts: true,
  },
  {
    id: 'captured-assignment-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} function read() { values.join = String(values) as any; } read(); read(); }`,
    converts: true,
  },
] as const;

describe("writes in a call's arguments, after it selected its method", () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'call-callee-order.ts', source);

    expect(convertsError(parsed.sourceFile)).toBe(converts);
  });

  it('keeps the selected method for a result-sensitive read', () => {
    const source =
      "function frames(error: Error) { const values = [error]; values.at = () => 'fixed'; return values.at(delete values.at); }";
    using api = openTypeScript();
    using parsed = parseModule(api, 'call-callee-order.ts', source);

    expect(overrideOf(parsed.sourceFile, 'at')).toBe(true);
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

/** Whether the source's call of the method on `values` finds the method written on it. */
function overrideOf(root: Node, method: string): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === method
    )
      return arrayMethodOverride(node.expression.expression, method, node)?.own === true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no call');
}
