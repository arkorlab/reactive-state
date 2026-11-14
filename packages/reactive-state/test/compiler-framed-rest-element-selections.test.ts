import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isIdentifier,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { frameBindingOf, frameTypeOf } from '../src/compiler/framed-bindings.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A rest element of a pattern holds copies of the members of the pattern it stands in, so a member
 * read through it is a member read of what the pattern takes apart: `rest.error` of
 * `{ a, ...rest }: { a: number; error: Error }` is the `error` of the parameter, whose type names an
 * error, as `error.stack` of `{ a, error }` is. The old paths said nothing of a rest (`undefined`), so
 * the member read was no read of an error. An array's rest after its first position holds the tail
 * at shifted indexes, which a path of keys does not say: it still says nothing. The rows marked a pin
 * answer the same before this change as after it.
 */
const PARAMETER = 'declare const target: (value: unknown) => void;';
const OPTIONS = '{ a: number; error: Error }';

const BINDINGS = [
  {
    expected: { keys: [] as string[], of: `{ a, ...rest }: ${OPTIONS}` },
    id: 'the-rest-of-an-object-parameter',
    source: `function f({ a, ...rest }: ${OPTIONS}) { target(rest); }`,
  },
  {
    expected: { keys: ['x'], of: `{ x: { a, ...rest } }: { x: ${OPTIONS} }` },
    id: 'the-rest-of-a-nested-object-pattern',
    source: `function f({ x: { a, ...rest } }: { x: ${OPTIONS} }) { target(rest); }`,
  },
  {
    expected: { keys: [], of: '{ a, ...rest } = props' },
    id: 'the-rest-of-a-variable-pattern',
    source: `declare const props: ${OPTIONS}; const { a, ...rest } = props; target(rest);`,
  },
  {
    expected: { keys: [], of: '{ [key]: a, ...rest }: Record<string, Error>' },
    id: 'a-rest-beside-a-computed-key-it-cannot-read',
    source: `declare const key: string; function f({ [key]: a, ...rest }: Record<string, Error>) { target(rest); }`,
  },
  {
    expected: { keys: [], of: '[...rest]: Error[]' },
    id: 'the-rest-of-an-array-from-its-first-position',
    source: `function f([...rest]: Error[]) { target(rest); }`,
  },
  {
    expected: { keys: ['0'], of: '[...[first]]: Error[]' },
    id: 'a-name-in-the-pattern-of-a-rest-from-the-first-position',
    source: `function f([...[first]]: Error[]) { target(first); }`,
  },
  {
    expected: undefined,
    id: 'the-rest-of-an-array-after-its-first-position-pin',
    source: `function f([first, ...rest]: Error[]) { target(rest); }`,
  },
  {
    expected: undefined,
    id: 'a-rest-in-a-tail-pattern-of-an-array-pin',
    source: `function f({ list: [first, ...rest] }: { list: Error[] }) { target(rest); }`,
  },
  {
    expected: { keys: ['a'], of: `{ a, ...rest }: ${OPTIONS}` },
    id: 'a-name-beside-a-rest-pin',
    source: `function f({ a, ...rest }: ${OPTIONS}) { target(a); }`,
  },
] as const;

const TYPES = [
  {
    expected: { keys: ['error'], type: OPTIONS },
    id: 'a-member-of-the-rest-of-an-object-parameter',
    source: `function f({ a, ...rest }: ${OPTIONS}) { target(rest.error); }`,
  },
  {
    expected: { keys: ['x', 'error'], type: `{ x: ${OPTIONS} }` },
    id: 'a-member-of-the-rest-of-a-nested-object-pattern',
    source: `function f({ x: { a, ...rest } }: { x: ${OPTIONS} }) { target(rest.error); }`,
  },
  {
    expected: { keys: ['error'], type: OPTIONS },
    id: 'a-member-of-the-rest-of-a-variable-pattern',
    source: `declare const props: ${OPTIONS}; const { a, ...rest } = props; target(rest.error);`,
  },
  {
    expected: { keys: ['0'], type: 'Error[]' },
    id: 'an-element-of-the-rest-of-an-array-from-its-first-position',
    source: `function f([...rest]: Error[]) { target(rest[0]); }`,
  },
  {
    expected: undefined,
    id: 'an-element-of-a-tail-by-a-key-it-cannot-read-pin',
    source: `declare const index: number; function f([first, ...rest]: Error[]) { target(rest[index]); }`,
  },
  {
    expected: { keys: ['error'], type: OPTIONS },
    id: 'a-name-beside-a-rest-pin',
    source: `function f({ a, error }: ${OPTIONS}) { target(error); }`,
  },
] as const;

/** The first argument of the last call of `target` in the source. */
function targeted(root: Node): Expression {
  const calls: CallExpression[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'target'
    )
      calls.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const argument = calls.at(-1)?.arguments[0];
  if (argument === undefined) throw new Error('No call of target.');
  return argument;
}

/** The binding the last `target` argument names, as its declaration's text and the keys to it. */
function bindingOf(source: string): { keys: readonly string[]; of: string } | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'rest-binding.ts', `${PARAMETER} ${source}`);
  const argument = targeted(parsed.sourceFile);
  const selected = isIdentifier(argument) ? frameBindingOf(argument) : undefined;
  return selected && { keys: selected.keys, of: selected.binding.getText(parsed.sourceFile) };
}

/** The written type the last `target` argument is selected from, as its text and the keys to it. */
function typeOf(source: string): { keys: readonly string[]; type: string } | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'rest-type.ts', `${PARAMETER} ${source}`);
  const selected = frameTypeOf(targeted(parsed.sourceFile));
  return selected && { keys: selected.keys, type: selected.type.getText(parsed.sourceFile) };
}

describe('a rest element of a binding pattern', () => {
  it.each(BINDINGS)('selects, as a binding, $id', ({ expected, source }) => {
    expect(bindingOf(source)).toStrictEqual(expected);
  });

  it.each(TYPES)('selects, as a type, $id', ({ expected, source }) => {
    expect(typeOf(source)).toStrictEqual(expected);
  });
});
