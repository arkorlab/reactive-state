import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isReturnStatement,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { writtenArrayElements } from '../src/compiler/framed-array-elements.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A mutator that is given what another call hands back writes the array behind it: the natives that
 * return their first argument or the array they are called on, called as a mutator is called, and
 * the expressions that give an operand as their value.
 */
const METHODS = [
  {
    id: 'inner-call-method-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Object.assign.call(null, values, {}), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-apply-method-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Object.assign.apply(null, [values, {}]), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-reflect-apply-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Reflect.apply(Object.assign, null, [values, {}]), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-function-call-call-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Function.prototype.call.call(Object.assign, null, values, {}), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-function-apply-call-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Function.prototype.apply.call(Object.assign, null, [values, {}]), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-constant-alias-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; const assign = Object.assign; values.join = () => 'fixed'; Object.assign(assign(values, {}), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-constant-alias-call-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; const assign = Object.assign; values.join = () => 'fixed'; Object.assign(assign.call(null, values, {}), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-comma-callee-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign((0, Object.assign)(values, {}), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-bound-alias-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; const assign = Object.assign.bind(null); values.join = () => 'fixed'; Object.assign(assign(values, {}), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-bound-with-the-array-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Object.assign.bind(null, values)({}), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-define-property-call-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Object.defineProperty.call(null, values, 'other', { value: 1 }), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-define-properties-apply-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Object.defineProperties.apply(null, [values, {}]), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-set-prototype-call-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Object.setPrototypeOf.call(null, values, Array.prototype), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-optional-call-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Object.assign?.(values, {}), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-fill-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(values.fill(error), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-sort-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(values.sort(), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-reverse-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(values.reverse(), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-copy-within-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(values.copyWithin(0, 0), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-borrowed-fill-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Array.prototype.fill.call(values, error), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-value-of-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(values.valueOf(), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-object-call-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Object(values), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-new-object-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(new Object(values), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-comma-value-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign((0, values), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-assignment-value-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; let held: unknown; values.join = () => 'fixed'; Object.assign((held = values), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-condition-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; const enabled = process.argv.length > 0; values.join = () => 'fixed'; Object.assign(enabled ? values : other, { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-logical-or-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(values || other, { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-nullish-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(other ?? values, { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'outer-call-inner-call-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign.call(null, Object.assign.call(null, values, {}), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'outer-bound-alias-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; const assign = Object.assign.bind(null); values.join = () => 'fixed'; assign(values, { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'outer-through-a-held-result-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; const done = Object.assign(values, {}); Object.assign(done, { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'outer-through-a-held-fill-restores-the-method',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; const done = values.fill(error); Object.assign(done, { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'inner-reflect-define-property-answers-a-boolean-pin',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Reflect.defineProperty(values, 'other', { value: 1 }), { join: Array.prototype.join }); return String(values); }`,
    converts: false,
  },
  {
    id: 'inner-assign-of-another-array-pin',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(Object.assign.call(null, other, {}), { join: Array.prototype.join }); return String(values); }`,
    converts: false,
  },
  {
    id: 'inner-fill-of-another-array-pin',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(other.fill(error), { join: Array.prototype.join }); return String(values); }`,
    converts: false,
  },
  {
    id: 'inner-bound-of-another-array-pin',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; const assign = Object.assign.bind(null); values.join = () => 'fixed'; Object.assign(assign(other, {}), { join: Array.prototype.join }); return String(values); }`,
    converts: false,
  },
  {
    id: 'inner-new-object-of-another-array-pin',
    source: `function frames(error: Error) { const values: unknown[] = [error]; const other: unknown[] = []; values.join = () => 'fixed'; Object.assign(new Object(other), { join: Array.prototype.join }); return String(values); }`,
    converts: false,
  },
] as const;

const ELEMENTS = [
  {
    id: 'assign-through-call-method',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; const other: unknown[] = []; Object.assign(Object.assign.call(null, values, {}), { 1: error }); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'assign-through-reflect-apply',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; const other: unknown[] = []; Object.assign(Reflect.apply(Object.assign, null, [values, {}]), { 1: error }); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'assign-through-a-constant-alias',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; const other: unknown[] = []; const assign = Object.assign; Object.assign(assign(values, {}), { 1: error }); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'assign-through-a-bound-alias',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; const other: unknown[] = []; const assign = Object.assign.bind(null); Object.assign(assign(values, {}), { 1: error }); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'assign-through-a-sort',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; const other: unknown[] = []; Object.assign(values.sort(), { 1: error }); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'assign-through-new-object',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; const other: unknown[] = []; Object.assign(new Object(values), { 1: error }); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'assign-through-a-comma',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; const other: unknown[] = []; Object.assign((0, values), { 1: error }); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'assign-through-a-condition',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; const other: unknown[] = []; const enabled = process.argv.length > 0; Object.assign(enabled ? values : other, { 1: error }); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'define-through-call-method',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; const other: unknown[] = []; Object.defineProperty.call(null, values, 1, { value: error }); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'assign-through-an-alias-of-the-result',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; const other: unknown[] = []; const done = Object.assign(values, {}); Object.assign(done, { 1: error }); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'assign-through-the-result-of-another-array-pin',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; const other: unknown[] = []; Object.assign(Object.assign.call(null, other, {}), { 1: error }); return values; }`,
    elements: [],
  },
] as const;

describe('the method a mutator restores through what another call hands back', () => {
  it.each(METHODS)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

describe('the elements a mutator installs through what another call hands back', () => {
  it.each(ELEMENTS)('$id', ({ source, elements }) => {
    expect(writtenElements(source)).toStrictEqual(elements);
  });
});

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'mutator-call-forms.ts', source);
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

/** The elements written to the returned array at any index, with their paths. */
function writtenElements(source: string): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'mutator-call-forms.ts', source);
  const read = returned(parsed.sourceFile);
  return writtenArrayElements(read, read).map((each) => {
    const path = each.array === true ? 'array' : each.keys.join('.');
    return `${each.value.getText()}:${path}`;
  });
}

function returned(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isReturnStatement(node) && node.expression !== undefined && isIdentifier(node.expression))
      return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no returned name');
}
