import { isElementAccessExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { consumed } from '../src/compiler/framed-consumed-uses.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A member read of an array is consumed where it stands when what it gives is not kept, handed to a
 * function or written through: an operator, a template, a native that reads it and answers a number, a text
 * or a boolean. A native that copies what it reads (`Object.values`, `Array.from`, `Object.entries`) or answers
 * the descriptors of its fields gives the parts of the member on: the list a member holds is in the answer.
 */
const READS = [
  ['a template', `\`\${a[0]}\``, true],
  ['a sum', 'a[0] + 1', true],
  ['a comparison', 'a[0] < 2', true],
  ['a minus', '-a[0]', true],
  ['a conversion to a number', 'Number(a[0])', true],
  ['a conversion to a text', 'String(a[0])', true],
  ['the keys', 'Object.keys(a[0])', true],
  ['a test for a list', 'Array.isArray(a[0])', true],
  ['a test for a frozen object', 'Object.isFrozen(a[0])', true],
  ['a conversion to JSON without a replacer', 'JSON.stringify(a[0])', true],
  ['the values', 'Object.values(a[0])', false],
  ['the entries', 'Object.entries(a[0])', false],
  ['a copy by Array.from', 'Array.from(a[0])', false],
  ['the descriptor of a field', "Object.getOwnPropertyDescriptor(a[0], 'x')", false],
  ['the descriptors of the fields', 'Object.getOwnPropertyDescriptors(a[0])', false],
  [
    'a conversion to JSON with a replacer',
    'JSON.stringify(a[0], (k: string, v: unknown) => v)',
    false,
  ],
  ['an argument of a function', 'f(a[0])', false],
  ['a second argument', 'Number(0, a[0])', false],
  ['a tagged template', `tag\`\${a[0]}\``, false],
  ['an increment', 'a[0]++', false],
  ['a logical operand', 'a[0] || 1', false],
] as const;

describe('a member read of an array that is consumed where it stands', () => {
  it.each(READS)('%s', (_name, expression, expected) => {
    expect(consumedAt(`const x = ${expression};`)).toBe(expected);
  });
});

/** Whether the first read `a[…]` of the source is consumed. */
function consumedAt(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'consumed-uses.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isElementAccessExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'a'
    )
      return consumed(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no read of a member');
}
