import {
  type CallExpression,
  isCallExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { concatSource, concatValues } from '../src/compiler/framed-concat-properties.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The array-like a concat copies is not a field's value, wherever it is written: a literal inside a
 * function or getter that a symbol-keyed property holds keeps its slots. A value a symbol-keyed field
 * itself holds is still not a slot.
 */
const CASES = [
  {
    id: 'reviewed-arrow-under-symbol',
    source:
      'function frames(error: Error) { return { [Symbol.toPrimitive]: () => { const value = { 0: error, length: 1, [Symbol.isConcatSpreadable]: true }; return ([] as any[]).concat(value)[0]; } }; }',
    slots: ['error'],
  },
  {
    id: 'getter-under-symbol',
    source:
      'function frames(error: Error) { return { get [Symbol.toStringTag]() { const value = { 0: error, length: 1, [Symbol.isConcatSpreadable]: true }; return ([] as any[]).concat(value)[0]; } }; }',
    slots: ['error'],
  },
  {
    id: 'direct-argument-under-symbol',
    source:
      'function frames(error: Error) { return { [Symbol.toPrimitive]: () => ([] as any[]).concat({ 0: error, length: 1, [Symbol.isConcatSpreadable]: true })[0] }; }',
    slots: ['error'],
  },
  {
    id: 'plain-function-pin',
    source:
      'function frames(error: Error) { const value = { 0: error, length: 1, [Symbol.isConcatSpreadable]: true }; return ([] as any[]).concat(value)[0]; }',
    slots: ['error'],
  },
  {
    id: 'symbol-field-value-pin',
    source:
      'function frames(error: Error) { const value = { [Symbol.toPrimitive]: error, length: 1, [Symbol.isConcatSpreadable]: true }; return ([] as any[]).concat(value)[0]; }',
    slots: [],
  },
] as const;

describe('concat slots of a literal under a symbol-keyed property', () => {
  it.each(CASES)('$id', ({ source, slots }) => {
    expect(firstSlot(source)).toStrictEqual(slots);
  });
});

/** The values slot `0` of the literal the source's concat copies may hold. */
function firstSlot(source: string): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'concat-symbol-contexts.ts', source);
  const root = concatSource(concatArgument(parsed.sourceFile), () => true);
  if (root === undefined || !isObjectLiteralExpression(root)) throw new Error('no literal');
  return concatValues(root, '0', () => true).map((each) => each.value.getText());
}

function concatArgument(root: Node): CallExpression['arguments'][number] {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'concat' &&
      node.arguments[0] !== undefined
    )
      return node.arguments[0];
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no concat call');
}
