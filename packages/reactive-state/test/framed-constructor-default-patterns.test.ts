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
 * A pattern inside a parameter's pattern takes apart what the outer one reads of the supplied
 * value — or the element's default, where that is undefined — and its reads are quiet only where
 * that is a shown ordinary literal: not an unknown value, whose members may be getters. Each
 * element of a pattern, nested or not, reads its member as a member read does: a getter's return
 * is scanned.
 * The scan no longer follows what a construction supplies: a default, or a `super` argument,
 * that reads a member, an element or a pattern is not quiet whatever is supplied. The rows marked a
 * pin answer the same before that change as after it; those marked "was quiet" answered true
 * before it.
 */

/** A constructor whose default is read along a path, beside a parameter of a nested pattern. */
const NESTED =
  'class Failure extends Error { constructor(fallback: unknown, { inner: { fix } }: { inner: { fix: unknown } }, options = fallback as { message: unknown }) { super(options.message as never); } }';

/** The same, of an array pattern inside the parameter's object pattern. */
const ELEMENTS =
  'class Failure extends Error { constructor(fallback: unknown, { inner: [first] }: { inner: unknown[] }, options = fallback as { message: unknown }) { super(options.message as never); } }';

/** A constructor whose default is read along a path, beside a parameter of a pattern. */
const TOP =
  'class Failure extends Error { constructor(fallback: unknown, { fix }: { fix: unknown }, options = fallback as { message: unknown }) { super(options.message as never); } }';

/** The same, of a rest. */
const REST =
  'class Failure extends Error { constructor(fallback: unknown, { ...rest }: { fix: unknown }, options = fallback as { message: unknown }) { super(options.message as never); } }';

/** A nested pattern of an element's default, which the constructor takes of its first argument. */
const DEFAULTED =
  'class Failure extends Error { constructor(fallback: unknown, { inner: { message } = fallback as { message: unknown } }: { inner?: { message: unknown } } = {}) { super(message as never); } }';

const CASES = [
  {
    made: 'new Failure({ message: error }, { inner: holder })',
    quiet: false,
    source: NESTED,
    what: 'an unknown value taken apart',
  },
  {
    made: 'new Failure({ message: error }, { inner: { get fix() { return mutate(); } } })',
    quiet: false,
    source: NESTED,
    what: 'a getter of a call taken apart',
  },
  {
    made: 'new Failure({ message: error }, { inner: holder })',
    quiet: false,
    source: ELEMENTS,
    what: 'an unknown value iterated',
  },
  {
    made: 'new Failure({ message: error }, { get fix() { return mutate(); } })',
    quiet: false,
    source: TOP,
    what: "a getter of a call a parameter's pattern reads",
  },
  {
    made: 'new Failure({ message: error }, { fix: 0 })',
    quiet: false,
    source: TOP,
    what: "a field a parameter's pattern reads (was quiet)",
  },
  {
    made: 'new Failure({ message: error }, holder)',
    quiet: false,
    source: TOP,
    what: "an unknown value a parameter's pattern reads (pin)",
  },
  {
    made: 'new Failure({ message: error }, { fix: 0 })',
    quiet: false,
    source: REST,
    what: 'a rest of a literal (was quiet)',
  },
  {
    made: 'new Failure({ message: error }, { inner: { fix: 0 } })',
    quiet: false,
    source: NESTED,
    what: 'a literal taken apart (was quiet)',
  },
  {
    made: 'new Failure({ message: error }, { inner: [0] })',
    quiet: false,
    source: ELEMENTS,
    what: 'an array iterated (was quiet)',
  },
  {
    made: 'new Failure({ message: error })',
    quiet: false,
    source: DEFAULTED,
    what: "an element's default taken apart (was quiet)",
  },
] as const;

describe('a constructor default beside the reads of a parameter pattern', () => {
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
