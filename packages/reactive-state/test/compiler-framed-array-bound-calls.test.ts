import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A call is read as the language runs it: a function made by `bind` is called with the arguments it
 * was given first and then those it is called with, `call` takes the first of them for its `this`,
 * and what `call`, `apply` and `bind` of a function make of each other follows from that. A method
 * that returns the array it is called on does so where it is the native one: where the code may give
 * the array another, what the call returns may be another array, and the target is no sure one.
 */
const HEAD =
  'function frames(error: Error, key: string, holder: object) { const values: unknown[] = [error]; const other: unknown[] = [];';

const CASES = [
  {
    id: 'call-bound-to-the-callee-writes-the-array-given-next-pin',
    source: `${HEAD} values.join = () => 'fixed'; const assign = Object.assign.call.bind(Object.assign, values); assign(other, { join: Array.prototype.join }); return String(values); }`,
    converts: false,
  },
  {
    id: 'call-bound-to-the-callee-with-the-array-first-in-the-call',
    source: `${HEAD} values.join = () => 'fixed'; const assign = Object.assign.call.bind(Object.assign, other); assign(values, { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'call-bound-with-a-this-and-the-array',
    source: `${HEAD} values.join = () => 'fixed'; Object.assign.call.bind(Object.assign, null, values)({ join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'call-bound-with-a-this-and-the-array-writes-an-element',
    source: `${HEAD} Object.assign.call.bind(Object.assign, null, values)({ 1: error }); return String(values); }`,
    converts: true,
  },
  {
    id: 'call-method-bound-to-the-callee',
    source: `${HEAD} values.join = () => 'fixed'; Function.prototype.call.bind(Object.assign)(null, values, { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'reflect-apply-bound-to-the-callee',
    source: `${HEAD} values.join = () => 'fixed'; Reflect.apply.bind(null, Object.assign, null)([values, { join: Array.prototype.join }]); return String(values); }`,
    converts: true,
  },
  {
    id: 'apply-method-bound-to-the-callee',
    source: `${HEAD} values.join = () => 'fixed'; Object.assign.apply.bind(Object.assign, null)([values, { join: Array.prototype.join }]); return String(values); }`,
    converts: true,
  },
  {
    id: 'bound-twice-with-the-array-first',
    source: `${HEAD} values.join = () => 'fixed'; Object.assign.bind(null, values).bind(null, other)({ join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'bound-twice-with-the-other-array-first-pin',
    source: `${HEAD} values.join = () => 'fixed'; Object.assign.bind(null, other).bind(null, values)({ join: Array.prototype.join }); return String(values); }`,
    converts: false,
  },
  {
    id: 'bind-of-bind-made-by-call',
    source: `${HEAD} values.join = () => 'fixed'; Function.prototype.bind.call(Object.assign.call, Object.assign, null, values)({ join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-given-another-result-by-an-assignment',
    source: `${HEAD} values.sort = () => other; Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'reverse-given-another-result-by-an-assignment',
    source: `${HEAD} values.reverse = () => other; Object.assign(values.reverse(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'fill-given-another-result-by-an-assignment',
    source: `${HEAD} values.fill = () => other; Object.assign(values.fill(0), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'copy-within-given-another-result-by-an-assignment',
    source: `${HEAD} values.copyWithin = () => other; Object.assign(values.copyWithin(0, 0), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'value-of-given-another-result-by-an-assignment',
    source: `${HEAD} values.valueOf = () => other; Object.assign(values.valueOf(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-given-another-result-by-a-definition',
    source: `${HEAD} Object.defineProperty(values, 'sort', { value: () => other }); Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-given-another-result-by-an-assign',
    source: `${HEAD} Object.assign(values, { sort: () => other }); Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-given-another-result-by-a-shorthand',
    source: `${HEAD} const sort = () => other; Object.assign(values, { sort }); Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-given-another-result-by-a-function',
    source: `${HEAD} function install(target: any) { target.sort = () => other; } install(values); Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-given-another-result-by-a-name',
    source: `${HEAD} const name = 'sort'; (values as any)[name] = () => other; Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-given-another-result-by-an-unread-name',
    source: `${HEAD} (values as any)[key] = () => other; Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-given-another-result-by-reflect-set',
    source: `${HEAD} Reflect.set(values, 'sort', () => other); Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-given-another-result-by-a-source-the-code-does-not-show',
    source: `${HEAD} Object.assign(values, holder); Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-given-another-result-by-a-prototype',
    source: `${HEAD} Object.setPrototypeOf(values, { sort: () => other }); Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-given-another-result-by-the-array-prototype',
    source: `${HEAD} (Array.prototype as any).sort = () => other; Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-borrowed-where-the-array-prototype-is-written',
    source: `${HEAD} (Array.prototype as any).sort = () => other; Object.assign(Array.prototype.sort.call(values), { join: () => 'fixed' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'sort-not-overridden-pin',
    source: `${HEAD} Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'sort-with-another-method-written-pin',
    source: `${HEAD} values.fill = () => other; Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'sort-with-another-field-in-an-object-pin',
    source: `${HEAD} const options = { order: 1 }; void options; Object.assign(values.sort(), { join: () => 'fixed' }); return String(values); }`,
    converts: false,
  },
] as const;

describe('the array a bound call, or a method that returns its receiver, writes', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'bound-calls.ts', source);
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
