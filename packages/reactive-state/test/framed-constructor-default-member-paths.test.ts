import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedSubclassMessages } from '../src/compiler/framed-subclass-messages.ts';

/**
 * What a local subclass's constructor passes on to its native base's message is the argument of
 * the construction read along the member path the `super` argument selects of it: `options.message`
 * of `options = fallback as { message: unknown }` is the `message` of what the construction wrote
 * as `fallback`. The path is followed wherever the construction's argument is taken as the default,
 * whatever else the defaults and the `super` arguments hold: a member read of what the
 * construction supplies, a call and an operator alike. The rows say which written argument is
 * forwarded at which path; the path being lost leaves the argument whole (`{ message: error }`, a
 * plain object, which converts to none of an error's words). A default the construction replaces
 * is not taken, and no path is followed through it. The path does not stand alone: where it stops
 * at a value the compile cannot read into (an `Error` the construction supplies, whose own `message`
 * is read), or meets a member that another default writes (`options[1] = options[0]`), what the
 * default selects it of is forwarded whole as well, as it is where the path is not followed. The
 * rows marked a pin answer the same before the change as after it.
 */

interface Case {
  /** Whether the construction's written `supplied` argument is forwarded at `path`. */
  readonly forwarded: boolean;
  /** The member path, its keys joined by dots; `*` is any member after it (a key not read). */
  readonly path: string;
  readonly source: string;
  readonly supplied: string;
  readonly what: string;
}

const FAILURE_OF_OPTIONS =
  'class Failure extends Error { constructor(fallback: unknown, options = fallback as { message: unknown }) { super(options.message as never); } }';

const CASES: readonly Case[] = [
  {
    forwarded: true,
    path: 'message',
    source: `${FAILURE_OF_OPTIONS} new Failure({ message: error });`,
    supplied: '{ message: error }',
    what: 'a member read of the default',
  },
  {
    forwarded: true,
    path: 'message',
    source: `${FAILURE_OF_OPTIONS} Reflect.construct(Failure, [{ message: error }]);`,
    supplied: '{ message: error }',
    what: 'the same, constructed by Reflect',
  },
  {
    forwarded: true,
    path: 'inner.message',
    source:
      'class Failure extends Error { constructor(fallback: unknown, options = (fallback as { inner: { message: unknown } }).inner) { super(options.message as never); } } new Failure({ inner: { message: error } });',
    supplied: '{ inner: { message: error } }',
    what: 'a default that selects a member of the argument',
  },
  {
    forwarded: true,
    path: 'message',
    source:
      'class Failure extends Error { constructor(fallback: unknown, first = fallback as { message: unknown }, options = first) { super(options.message as never); } } new Failure({ message: error });',
    supplied: '{ message: error }',
    what: 'a default that names another default',
  },
  {
    forwarded: true,
    path: 'message',
    source:
      'class Failure extends Error { constructor(fallback: unknown, { message } = fallback as { message: unknown }) { super(message as never); } } new Failure({ message: error });',
    supplied: '{ message: error }',
    what: 'a pattern default',
  },
  {
    forwarded: true,
    path: 'message',
    source:
      'class Failure extends Error { constructor(fallback: unknown, { inner: { message } = fallback as { message: unknown } }: { inner?: { message: unknown } } = {}) { super(message as never); } } new Failure({ message: error });',
    supplied: '{ message: error }',
    what: 'a default of a binding element in a nested pattern',
  },
  {
    forwarded: true,
    path: '0.message',
    source:
      'class Failure extends Error { constructor(fallback: unknown, options = fallback as readonly { message: unknown }[]) { super(options[0]!.message as never); } } new Failure([{ message: error }]);',
    supplied: '[{ message: error }]',
    what: 'an element read, then a member read',
  },
  {
    forwarded: true,
    path: 'message',
    source:
      'class Failure extends Error { constructor(fallback: unknown, options = fallback as { message: unknown }) { super(options["message"] as never); } } new Failure({ message: error });',
    supplied: '{ message: error }',
    what: 'a member read by a written text',
  },
  {
    forwarded: true,
    path: 'message',
    source:
      'class Failure extends AggregateError { constructor(fallback: unknown, options = fallback as { message: unknown }) { super([], options.message as never); } } new Failure({ message: error });',
    supplied: '{ message: error }',
    what: 'the message of an AggregateError',
  },
  {
    forwarded: true,
    path: 'message',
    source:
      'class Failure extends DOMException { constructor(fallback: unknown, options = fallback as { message: unknown }) { super(options.message as never); } } new Failure({ message: error });',
    supplied: '{ message: error }',
    what: 'the message of a DOMException',
  },
  {
    forwarded: true,
    path: 'name',
    source:
      'class Failure extends DOMException { constructor(fallback: unknown, options = fallback as { name: unknown }) { super("fixed", options.name as never); } } new Failure({ name: error });',
    supplied: '{ name: error }',
    what: 'the name of a DOMException',
  },
  {
    forwarded: true,
    path: 'message',
    source: `${FAILURE_OF_OPTIONS} new Failure({ get message() { return error; } });`,
    supplied: '{ get message() { return error; } }',
    what: 'a getter the construction supplies',
  },
  {
    forwarded: true,
    path: 'message',
    source: `${FAILURE_OF_OPTIONS} new Failure({ message: [error] });`,
    supplied: '{ message: [error] }',
    what: 'an array that holds the error',
  },
  {
    forwarded: true,
    path: 'message',
    source: `${FAILURE_OF_OPTIONS} new Failure({ message: error }, undefined);`,
    supplied: '{ message: error }',
    what: 'an argument written as undefined',
  },
  {
    forwarded: true,
    path: 'message',
    source: `${FAILURE_OF_OPTIONS} const Make = Failure as new (...args: unknown[]) => Failure; new Make({ message: error }, undefined, 0);`,
    supplied: '{ message: error }',
    what: 'an argument the constructor does not name',
  },
  {
    forwarded: true,
    path: '*',
    source:
      'class Failure extends Error { constructor(fallback: unknown, key: string, options = fallback as Record<string, unknown>) { super(options[key] as never); } } new Failure({ message: error }, "message");',
    supplied: '{ message: error }',
    what: 'a key the compile cannot read',
  },
  {
    forwarded: true,
    path: 'message',
    source:
      'class Failure extends Error { constructor(fallback: unknown, options = fallback as { message: unknown }) { super(options.message as never, { cause: 0 }); } } new Failure({ message: error });',
    supplied: '{ message: error }',
    what: 'a literal option beside the message',
  },
  {
    forwarded: true,
    path: 'message',
    source:
      'class Failure extends Error { constructor(fallback: unknown, options = fallback as { message: unknown }, count = 1 + 1) { super(options.message as never); } } new Failure({ message: error });',
    supplied: '{ message: error }',
    what: 'an operator in another default',
  },
  {
    forwarded: true,
    path: 'message',
    source:
      'class Failure extends Error { constructor(fallback: unknown, options = fallback as { message: unknown }, count = Math.abs(1)) { super(options.message as never); } } new Failure({ message: error });',
    supplied: '{ message: error }',
    what: 'a call in another default',
  },
  {
    forwarded: true,
    path: 'message',
    source:
      'class Failure extends Error { constructor(fallback: unknown, options = fallback as { message: unknown }) { super(options.message as never, { cause: Math.abs(1) }); } } new Failure({ message: error });',
    supplied: '{ message: error }',
    what: 'a call in the `super` argument beside the message',
  },
  {
    forwarded: false,
    path: 'message',
    source: `${FAILURE_OF_OPTIONS} new Failure({ message: error }, { message: "fixed" });`,
    supplied: '{ message: error }',
    what: 'a default the construction replaces (pin)',
  },
  {
    forwarded: true,
    path: 'message',
    source: `${FAILURE_OF_OPTIONS} new Failure({ message: error }, { message: "fixed" });`,
    supplied: '{ message: "fixed" }',
    what: 'the argument that replaces it (pin)',
  },
  {
    forwarded: false,
    path: 'message',
    source:
      'class Failure extends Error { constructor(fallback: unknown, options = fallback as { message: unknown }) { super("fixed"); } } new Failure({ message: error });',
    supplied: '{ message: error }',
    what: 'a `super` argument that reads no parameter (pin)',
  },
  {
    forwarded: true,
    path: '',
    source: `${FAILURE_OF_OPTIONS} new Failure(error);`,
    supplied: 'error',
    what: 'an Error supplied whole, whose own message the path reads',
  },
  {
    forwarded: true,
    path: '',
    source:
      'class Failure extends Error { constructor(fallback: unknown, options = fallback as { message: unknown }, count = Math.abs(1)) { super(options.message as never); } } new Failure(error);',
    supplied: 'error',
    what: 'the same beside a call in another default',
  },
  {
    forwarded: true,
    path: 'inner',
    source:
      'class Failure extends Error { constructor(fallback: unknown, options = (fallback as { inner: { message: unknown } }).inner) { super(options.message as never); } } new Failure({ inner: error });',
    supplied: '{ inner: error }',
    what: 'an Error held by the argument, whose own message the path reads',
  },
  {
    forwarded: true,
    path: '',
    source:
      "class Failure extends Error { constructor(fallback: unknown[], options = fallback, ignored = (options[1] = options[0])) { super(options[1] as never); } } new Failure([error, 'fixed']);",
    supplied: "[error, 'fixed']",
    what: 'an array that another default writes an element of',
  },
  {
    forwarded: true,
    path: '',
    source:
      "class Failure extends Error { constructor(fallback: unknown[], options = fallback, ignored = options.reverse()) { super(options[1] as never); } } new Failure([error, 'fixed']);",
    supplied: "[error, 'fixed']",
    what: 'an array that another default reorders',
  },
];

/** A `new` of a name, or a `Reflect.construct` call: the constructions the rows write. */
function isConstruction(node: Node): node is Expression {
  if (isNewExpression(node)) return isIdentifier(node.expression);
  return isCallExpression(node) && node.expression.getText() === 'Reflect.construct';
}

const NATIVE_ERRORS: ReadonlySet<string> = new Set(['AggregateError', 'DOMException', 'Error']);

describe('what a constructor default forwards along the member path it selects', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The value pairs, `[written, path]`, the construction of `Failure` forwards to the native base. */
  function forwardedBy(source: string): readonly (readonly [string, string])[] {
    using parsed = api.createSourceFile(
      'framed-constructor-default-member-paths.ts',
      ['declare const error: Error;', source].join('\n'),
    );
    let construction: Expression | undefined;
    const visit = (node: Node): void => {
      if (construction === undefined && isConstruction(node)) construction = node;
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (construction === undefined) throw new Error('No construction of Failure is written.');
    return (framedSubclassMessages(construction, NATIVE_ERRORS) ?? []).map((each) => {
      return [
        each.value.getText(),
        each.any === true ? [...each.keys, '*'].join('.') : each.keys.join('.'),
      ];
    });
  }

  it.each(CASES)('$what', ({ forwarded, path, source, supplied }) => {
    const found = forwardedBy(source).some(([written, at]) => written === supplied && at === path);

    expect(found).toBe(forwarded);
  });
});
