import {
  type Identifier,
  isExpressionWithTypeArguments,
  isIdentifier,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { localClassValueBinding } from '../src/compiler/local-type-aliases.ts';

/**
 * A `var` the module declares in one of its blocks — a block, a condition, a loop's head, a `try` —
 * is the module's, as a function's `var`s are the function's: a class base read by its name past
 * the block is that variable, kept opaque, and not the built-in of the name. A `let` of a block, a
 * function's `var` and a namespace's are their own, and leave the name the built-in's there.
 */

const CASES = [
  { binding: 'opaque', lines: ['{', '  var Error = class {};', '}'], what: "a block's var" },
  {
    binding: 'opaque',
    lines: ['if (true) {', '  var Error = class {};', '}'],
    what: "a condition's var",
  },
  { binding: 'opaque', lines: ['for (var Error of [class {}]) {}'], what: "a loop head's var" },
  {
    binding: 'opaque',
    lines: ['try {', '  var Error = class {};', '} catch {}'],
    what: "a try's var",
  },
  { binding: 'opaque', lines: ['var Error = class {};'], what: "the module's own var" },
  {
    binding: 'VariableDeclaration',
    lines: ['const Error = class {};'],
    what: "the module's constant",
  },
  { binding: 'none', lines: [], what: 'no declaration' },
  { binding: 'none', lines: ['{', '  let Error = class {};', '}'], what: "a block's let" },
  {
    binding: 'none',
    lines: ['function scoped() {', '  var Error = class {};', '}'],
    what: "a function's var",
  },
  {
    binding: 'none',
    lines: ['namespace Inner {', '  {', '    var Error = 1;', '  }', '}'],
    what: "a namespace's var",
  },
] as const;

describe('a class base a var of a module block names', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `localClassValueBinding` answers of `Error`, the base of a class after `lines`. */
  function bindingOf(lines: readonly string[]): string {
    const source = [...lines, 'class Failure extends Error {}', ''].join('\n');
    using parsed = api.createSourceFile('bases.ts', source);
    let base: Identifier | undefined;
    const visit = (node: Node): void => {
      if (isIdentifier(node) && isExpressionWithTypeArguments(node.parent)) {
        base = node;
      }
      node.forEachChild(visit);
    };
    parsed.sourceFile.forEachChild(visit);
    if (base === undefined) {
      throw new Error('No class base is read.');
    }
    const binding = localClassValueBinding(base);
    if (binding === undefined) {
      return 'none';
    }
    return binding === null ? 'opaque' : SyntaxKind[binding.kind];
  }

  it.each(CASES)('$what', ({ binding, lines }) => {
    expect(bindingOf(lines)).toBe(binding);
  });
});
