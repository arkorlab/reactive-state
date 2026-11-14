import {
  type CallExpression,
  type ConstructorDeclaration,
  isCallExpression,
  isConstructorDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedConstructorDefaultEvaluation } from '../src/compiler/framed-constructor-default-evaluation.ts';

/**
 * A constructor's defaults, and the `super` argument beside them, are evaluated quietly only where
 * their code reads no member, no element and no pattern: such a read takes its value from what the
 * construction supplies, which may be a getter, a proxy or an iterator, and the scan does not follow
 * what is supplied. A name, a literal, a function written and not run, and a type are quiet. The
 * answer does not depend on the construction written beside the class, as the rows that differ
 * only in it show. The rows marked a pin answer the same before the change as after it.
 */

const CASES = [
  {
    made: 'new Failure()',
    quiet: true,
    source: "class Failure extends Error { constructor(message = 'failed') { super(message); } }",
    what: 'a literal default (pin)',
  },
  {
    made: 'new Failure()',
    quiet: true,
    source:
      "class Failure extends Error { constructor(options = { prefix: 'x' }, message = 'm') { super(message); } }",
    what: 'an object literal default (pin)',
  },
  {
    made: 'new Failure("x")',
    quiet: true,
    source:
      'class Failure extends Error { constructor(first: string, message = first) { super(message); } }',
    what: 'a default that names a prior parameter (pin)',
  },
  {
    made: 'new Failure({ label: "x" })',
    quiet: true,
    source:
      'class Failure extends Error { constructor(options: any, read = () => options.label) { super(read as never); } }',
    what: 'a function written in a default and not run (pin)',
  },
  {
    made: 'new Failure({ label: "x" })',
    quiet: true,
    source:
      "class Failure extends Error { constructor(options: { label: string }, message: typeof options.label = 'm') { super(message); } }",
    what: 'a member read written in a type (pin)',
  },
  {
    made: 'new Failure({ label: "x" })',
    quiet: false,
    source:
      'class Failure extends Error { constructor(options: { label: string }, message = options.label) { super(message); } }',
    what: 'a member read of a literal the construction supplies',
  },
  {
    made: 'new Failure(holder)',
    quiet: false,
    source:
      'class Failure extends Error { constructor(options: { label: string }, message = options.label) { super(message); } }',
    what: 'the same member read of a value the construction does not show (pin)',
  },
  {
    made: 'new Failure({ get label() { return mutate(); } })',
    quiet: false,
    source:
      'class Failure extends Error { constructor(options: { label: string }, message = options.label) { super(message); } }',
    what: 'the same member read of a getter (pin)',
  },
  {
    made: 'new Failure()',
    quiet: false,
    source:
      "class Failure extends Error { constructor(options = { label: 'x' }, message = options.label) { super(message); } }",
    what: 'a member read of a literal default',
  },
  {
    made: 'new Failure(["x"])',
    quiet: false,
    source:
      'class Failure extends Error { constructor(list: string[], message = list[0]) { super(message); } }',
    what: 'an element of an array the construction supplies',
  },
  {
    made: 'new Failure({ label: "x" })',
    quiet: false,
    source:
      'class Failure extends Error { constructor(options: { label: string }) { super(options.label); } }',
    what: 'a member read in the super argument',
  },
  {
    made: 'new Failure({ label: "x" })',
    quiet: false,
    source:
      'class Failure extends Error { constructor({ label }: { label: string }) { super(label); } }',
    what: 'an object pattern of a parameter',
  },
  {
    made: 'new Failure(["x"])',
    quiet: false,
    source: 'class Failure extends Error { constructor([first]: string[]) { super(first); } }',
    what: 'an array pattern of a parameter',
  },
  {
    made: 'new Failure({ inner: { label: "x" } })',
    quiet: false,
    source:
      'class Failure extends Error { constructor({ inner: { label } }: { inner: { label: string } }) { super(label); } }',
    what: 'a pattern inside a pattern',
  },
  {
    made: 'new Failure()',
    quiet: false,
    source:
      "class Failure extends Error { constructor({ label = 'x' }: { label?: string } = {}) { super(label); } }",
    what: 'a pattern with a default of its own',
  },
  {
    made: 'new Failure()',
    quiet: false,
    source: 'class Failure extends Error { constructor(message = make()) { super(message); } }',
    what: 'a call (pin)',
  },
  {
    made: 'new Failure({ label: "x" })',
    quiet: false,
    source:
      'class Failure extends Error { constructor(options: { label: string }, message = holder.label) { super(message); } }',
    what: 'a member read of a name that is no parameter (pin)',
  },
] as const;

describe("a constructor default's evaluation, whatever the construction supplies", () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the defaults and the `super` argument of `Failure` are evaluated quietly. */
  function quietOf(source: string, made: string): boolean {
    using parsed = api.createSourceFile(
      'framed-constructor-default-reads.ts',
      [
        'declare const holder: { label: string };',
        'declare function mutate(): string;',
        'declare function make(): string;',
        source,
        `${made};`,
      ].join('\n'),
    );
    let constructor: ConstructorDeclaration | undefined;
    let call: CallExpression | undefined;
    const visit = (node: Node): void => {
      if (isConstructorDeclaration(node)) constructor = node;
      if (isCallExpression(node) && node.expression.kind === SyntaxKind.SuperKeyword) call = node;
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (constructor === undefined || call === undefined) {
      throw new Error(`No constructor of Failure with a super call in ${source}.`);
    }
    return framedConstructorDefaultEvaluation(constructor.parameters, call.arguments);
  }

  it.each(CASES)('$what', ({ made, quiet, source }) => {
    expect(quietOf(source, made)).toBe(quiet);
  });
});
