import { type Expression, isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedQuietData, framedQuietInputs } from '../src/compiler/framed-native-evaluation.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A literal written as an input of a native evaluates nothing of the application, unless a member of
 * it is a conversion hook the native then runs: `toString`, `valueOf` and `__proto__` are refused by
 * the name, whether the member is written `toString: value`, `toString() {}`, `get toString() {}`
 * or, as here, by the shorthand `{ toString }`, which a function the file holds under that name
 * fills as well. A shorthand of another name, and a literal of data, are as they were.
 */
const NATIVES = new Set(['DOMException', 'Error']);

const CASES = [
  {
    id: 'shorthand-to-string',
    source: 'function frames(toString: () => string) { read({ toString }); }',
    quiet: false,
  },
  {
    id: 'shorthand-value-of',
    source: 'function frames(valueOf: () => number) { read({ valueOf }); }',
    quiet: false,
  },
  {
    id: 'shorthand-proto',
    source: 'function frames(__proto__: object) { read({ __proto__ }); }',
    quiet: false,
  },
  {
    id: 'shorthand-to-string-beside-data',
    source: "function frames(toString: () => string) { read({ code: 'x', toString }); }",
    quiet: false,
  },
  {
    id: 'shorthand-to-string-in-a-nested-literal',
    source: 'function frames(toString: () => string) { read({ options: { toString } }); }',
    quiet: false,
  },
  {
    id: 'shorthand-to-string-in-a-list',
    source: 'function frames(toString: () => string) { read([{ toString }]); }',
    quiet: false,
  },
  {
    id: 'shorthand-to-string-in-a-spread-literal',
    source: 'function frames(toString: () => string) { read({ ...{ toString } }); }',
    quiet: false,
  },
  {
    id: 'shorthand-to-string-in-a-constant',
    source: 'function frames(toString: () => string) { const hooks = { toString }; read(hooks); }',
    quiet: false,
  },
  {
    id: 'shorthand-to-string-of-a-function-declaration',
    source: "function frames() { function toString() { return 'x'; } read({ toString }); }",
    quiet: false,
  },
  {
    id: 'shorthand-to-string-of-a-constant-text',
    source: "function frames() { const toString = 'x'; read({ toString }); }",
    quiet: false,
  },
  {
    id: 'property-to-string-pin',
    source: 'function frames(hook: () => string) { read({ toString: hook }); }',
    quiet: false,
  },
  {
    id: 'method-to-string-pin',
    source: "function frames() { read({ toString() { return 'x'; } }); }",
    quiet: false,
  },
  {
    id: 'getter-to-string-pin',
    source: 'function frames(hook: () => string) { read({ get toString() { return hook; } }); }',
    quiet: false,
  },
  {
    id: 'shorthand-message-pin',
    source: 'function frames(message: string) { read({ message }); }',
    quiet: true,
  },
  {
    id: 'shorthand-cause-and-code-pin',
    source: 'function frames(cause: Error, code: number) { read({ cause, code }); }',
    quiet: true,
  },
  {
    id: 'shorthand-in-a-nested-literal-pin',
    source: 'function frames(cause: Error) { read({ options: { cause } }); }',
    quiet: true,
  },
  {
    id: 'shorthand-in-a-constant-pin',
    source: 'function frames(cause: Error) { const options = { cause }; read(options); }',
    quiet: true,
  },
  {
    id: 'property-of-another-name-pin',
    source: 'function frames(cause: Error) { read({ cause: cause }); }',
    quiet: true,
  },
  {
    id: 'shorthand-named-like-a-prototype-member-pin',
    source: 'function frames(constructor: unknown) { read({ constructor }); }',
    quiet: true,
  },
  {
    id: 'literal-of-data-pin',
    source: "function frames() { read({ code: 1, name: 'x', parts: [1, 2] }); }",
    quiet: true,
  },
] as const;

/** The argument of the one call of `read` in `root`. */
function readArgument(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node) && node.expression.getText() === 'read') {
      const [first] = node.arguments;
      if (first !== undefined) return first;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no call of read');
}

const DATA = [
  {
    id: 'shorthand-to-string-of-a-constant-text',
    source: "function frames() { const toString = 'x'; read({ toString }); }",
    quiet: false,
  },
  {
    id: 'shorthand-value-of-of-a-constant-number',
    source: 'function frames() { const valueOf = 1; read({ valueOf }); }',
    quiet: false,
  },
  {
    id: 'shorthand-of-a-constant-text-pin',
    source: "function frames() { const label = 'x'; read({ label }); }",
    quiet: true,
  },
  {
    id: 'shorthand-of-a-constant-number-beside-data-pin',
    source: 'function frames() { const code = 1; read({ code, parts: [1, 2] }); }',
    quiet: true,
  },
  {
    id: 'shorthand-of-a-parameter-pin',
    source: 'function frames(label: string) { read({ label }); }',
    quiet: false,
  },
] as const;

describe('a native input that holds a conversion hook by the shorthand', () => {
  it.each(CASES)('inputs: $id', ({ source, quiet }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'x.ts', source);

    expect(framedQuietInputs([readArgument(parsed.sourceFile)], NATIVES)).toBe(quiet);
  });

  it.each(DATA)('data: $id', ({ source, quiet }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'x.ts', source);

    expect(framedQuietData(readArgument(parsed.sourceFile))).toBe(quiet);
  });
});
