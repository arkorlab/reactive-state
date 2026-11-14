import {
  type CallExpression,
  type ConstructorDeclaration,
  isCallExpression,
  isConstructorDeclaration,
  isNewExpression,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedConstructorDefaultEvaluation } from '../src/compiler/framed-constructor-default-evaluation.ts';

/**
 * A rest parameter holds the arguments from its position on, as an array: the argument written at
 * its position is its first element, not its value, and `rest[1]` is the argument after it. What
 * the evaluation reads of a rest parameter is therefore no member of the argument at its position —
 * a read of `rest[1].x` is not the second element of an array literal given there — and a pattern
 * of a rest parameter takes apart that array, not the argument. The rows marked a pin answer the
 * same before the change as after it.
 */

/** A constructor whose `super` argument is read through the rest parameter `args`. */
const argumentOf = (read: string): string =>
  `class Failure extends Error { constructor(...args: any[]) { super(${read} as never); } }`;

/** The same, beside a parameter before the rest. */
const besideOf = (read: string): string =>
  `class Failure extends Error { constructor(first: any, ...args: any[]) { super(${read} as never); } }`;

/** A rest parameter that is a pattern. */
const PATTERN =
  'class Failure extends Error { constructor(...[first, { x }]: any[]) { super(x as never); } }';

/** Positional parameters, as a pin. */
const POSITIONAL =
  'class Failure extends Error { constructor(a: any, b: any) { super(b.x as never); } }';

const CASES = [
  {
    made: 'new Failure([0, { x: 1 }], { get x() { return mutate(); } })',
    quiet: false,
    source: argumentOf('args[1].x'),
    what: 'the second argument read through the rest, where the first is an array',
  },
  {
    made: 'new Failure(0, [0, { x: 1 }], { get x() { return mutate(); } })',
    quiet: false,
    source: besideOf('args[1].x'),
    what: 'the rest beside a parameter before it',
  },
  {
    made: 'new Failure([0, { x: 1 }], { get x() { return mutate(); } })',
    quiet: false,
    source: PATTERN,
    what: 'a pattern of a rest parameter over the arguments',
  },
  {
    made: 'new Failure({ x: 1 })',
    quiet: false,
    source: argumentOf('args[0].x'),
    what: 'the first argument read through the rest (pin)',
  },
  {
    made: 'new Failure({ x: 1 })',
    quiet: false,
    source: argumentOf('args.x'),
    what: "a field of the rest array, read as the first argument's",
  },
  {
    made: 'new Failure({ x: 1 })',
    quiet: false,
    source: 'class Failure extends Error { constructor(...args: any[]) { super(...args); } }',
    what: 'the rest spread on (pin)',
  },
  {
    made: 'new Failure([0, { x: 1 }], { x: 2 })',
    quiet: true,
    source: POSITIONAL,
    what: 'positional parameters (pin)',
  },
] as const;

describe('a constructor evaluation beside a rest parameter', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the default evaluation of the class `source` is quiet, constructed as `made`. */
  function quietOf(source: string, made: string): boolean {
    using parsed = api.createSourceFile(
      'framed-constructor-rest-inputs.ts',
      ['declare function mutate(): unknown;', source, `${made};`].join('\n'),
    );
    let constructor: ConstructorDeclaration | undefined;
    let construction: NewExpression | undefined;
    let call: CallExpression | undefined;
    const visit = (node: Node): void => {
      if (isConstructorDeclaration(node)) constructor = node;
      if (isNewExpression(node) && node.expression.getText() === 'Failure') construction = node;
      if (isCallExpression(node) && node.expression.kind === SyntaxKind.SuperKeyword) call = node;
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (constructor === undefined || construction === undefined || call === undefined) {
      throw new Error(`No construction of Failure as ${made}.`);
    }
    const slots = (construction.arguments ?? []).map((value) => [{ keys: [], value }]);
    return framedConstructorDefaultEvaluation(constructor.parameters, slots, call.arguments);
  }

  it.each(CASES)('$what', ({ made, quiet, source }) => {
    expect(quietOf(source, made)).toBe(quiet);
  });
});
