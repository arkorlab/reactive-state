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
 * An array pattern takes apart what it is given by iterating it: of an array literal the
 * language's own iteration, which reads its elements alone, but of an object literal its own
 * `Symbol.iterator`, whose code is the application's — and of an object of none, a throw. Only an
 * array literal is a quiet source of an array pattern.
 * The scan no longer follows what a construction supplies: a default, or a `super` argument,
 * that reads a member, an element or a pattern is not quiet whatever is supplied. The rows marked a
 * pin answer the same before that change as after it; those marked "was quiet" answered true
 * before it.
 */

/** A constructor whose default is read along a path, beside a parameter of an array rest. */
const REST =
  'class Failure extends Error { constructor(fallback: unknown, [...rest]: unknown[], options = fallback as { message: unknown }) { super(options.message as never); } }';

/** The same, of an array pattern of one element. */
const FIRST =
  'class Failure extends Error { constructor(fallback: unknown, [first]: unknown[], options = fallback as { message: unknown }) { super(options.message as never); } }';

/** The same, of an array pattern inside the parameter's object pattern. */
const NESTED =
  'class Failure extends Error { constructor(fallback: unknown, { inner: [first] }: { inner: unknown[] }, options = fallback as { message: unknown }) { super(options.message as never); } }';

const ITERABLE = '{ [Symbol.iterator]: function* () { mutate(); yield 0; } }';

const CASES = [
  {
    made: `new Failure({ message: error }, ${ITERABLE} as never)`,
    quiet: false,
    source: REST,
    what: 'an iterable object copied by a rest',
  },
  {
    made: `new Failure({ message: error }, ${ITERABLE} as never)`,
    quiet: false,
    source: FIRST,
    what: 'an iterable object taken apart (pin)',
  },
  {
    made: "new Failure({ message: error }, { 0: 'x', length: 1 } as never)",
    quiet: false,
    source: FIRST,
    what: 'an object of no iterator taken apart',
  },
  {
    made: `new Failure({ message: error }, { inner: ${ITERABLE} } as never)`,
    quiet: false,
    source: NESTED,
    what: 'an iterable object taken apart inside (pin)',
  },
  {
    made: 'new Failure({ message: error }, [0, 1])',
    quiet: false,
    source: REST,
    what: 'an array copied by a rest (was quiet)',
  },
  {
    made: 'new Failure({ message: error }, { inner: [0] })',
    quiet: false,
    source: NESTED,
    what: 'an array taken apart inside (was quiet)',
  },
] as const;

describe('a constructor default beside an array pattern of a parameter', () => {
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
      'framed-constructor-patterns.ts',
      [
        'declare const error: Error;',
        'declare const holder: never;',
        'declare function mutate(): unknown;',
        source,
        `${made};`,
      ].join('\n'),
    );
    let constructor: ConstructorDeclaration | undefined;
    let construction: NewExpression | undefined;
    let call: CallExpression | undefined;
    const visit = (node: Node): void => {
      if (isConstructorDeclaration(node)) constructor = node;
      if (isNewExpression(node)) construction = node;
      if (isCallExpression(node) && node.expression.kind === SyntaxKind.SuperKeyword) call = node;
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (constructor === undefined || construction === undefined || call === undefined) {
      throw new Error(`No construction of Failure as ${made}.`);
    }
    return framedConstructorDefaultEvaluation(constructor.parameters, call.arguments);
  }

  it.each(CASES)('$what', ({ made, quiet, source }) => {
    expect(quietOf(source, made)).toBe(quiet);
  });
});
