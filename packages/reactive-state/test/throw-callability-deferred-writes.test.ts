import { type CallExpression, type Expression, isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { invocationThrows, nullishCallee } from '../src/compiler/throw-callability.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A member of a literal a call reads is the literal's own only where nothing the code runs later can
 * have written it: a function declared before a write to the literal reads the member the write
 * left, and `calleeUncertain` finds a write made across such a boundary (a write anywhere in the
 * file to the object, or the object handed to a call), which the lexical `interveningEvaluation`
 * does not.
 */

/** A module, the text of the callee of the call to read, and whether that call surely throws. */
interface Row {
  readonly id: string;
  readonly source: string;
  readonly callee: string;
  readonly throws: boolean;
}

const ROWS: readonly Row[] = [
  // The member is replaced after the function that calls it, the order a registry is written in.
  {
    callee: 'handlers.run',
    id: 'a member replaced after the function that calls it',
    source:
      'const handlers = { run: 0 as unknown as () => number };\nfunction invoke() { return handlers.run(); }\nhandlers.run = () => 1;\n',
    throws: false,
  },
  {
    callee: 'handlers.run!',
    id: 'an empty registry filled after the function that calls it',
    source:
      'const handlers: { run?: () => number } = {};\nfunction invoke() { return handlers.run!(); }\nhandlers.run = () => 1;\n',
    throws: false,
  },
  {
    callee: "handlers['run']!",
    id: 'the same through an element access',
    source:
      "const handlers: { run?: () => number } = {};\nfunction invoke() { return handlers['run']!(); }\nhandlers.run = () => 1;\n",
    throws: false,
  },
  {
    callee: 'bag.run!',
    id: 'a bag of no prototype filled after the function that calls it',
    source:
      'const bag = Object.create(null) as { run?: () => number };\nfunction invoke() { return bag.run!(); }\nbag.run = () => 1;\n',
    throws: false,
  },
  {
    callee: 'handlers.run!',
    id: 'a member written by a function declared after the one that calls it',
    source:
      'const handlers: { run?: () => number } = {};\nfunction invoke() { return handlers.run!(); }\nfunction register() { handlers.run = () => 1; }\n',
    throws: false,
  },
  {
    callee: 'handlers.run!',
    id: 'an object handed to a call after the function that calls its member',
    source:
      'declare function register(target: { run?: () => number }): void;\nconst handlers: { run?: () => number } = {};\nfunction invoke() { return handlers.run!(); }\nregister(handlers);\n',
    throws: false,
  },
  {
    callee: 'handlers.run!',
    id: 'another member of the object written after the function (the rule is coarse)',
    source:
      'const handlers: { run?: () => number; stop?: () => void } = {};\nfunction invoke() { return handlers.run!(); }\nhandlers.stop = () => undefined;\n',
    throws: false,
  },
  // What stays a throw: nothing the code runs later writes the object.
  {
    callee: 'handlers.run',
    id: 'a member that is no function, in a function, never written',
    source:
      'const handlers = { run: 0 as unknown as () => number };\nfunction invoke() { return handlers.run(); }\n',
    throws: true,
  },
  {
    callee: 'handlers.run!',
    id: 'an empty object, in a function, never written',
    source:
      'const handlers: { run?: () => number } = {};\nfunction invoke() { return handlers.run!(); }\n',
    throws: true,
  },
  {
    callee: 'bag.run!',
    id: 'a bag of no prototype, in a function, never written',
    source:
      'const bag = Object.create(null) as { run?: () => number };\nfunction invoke() { return bag.run!(); }\n',
    throws: true,
  },
  {
    callee: 'handlers.run',
    id: 'a write to another object of the same shape',
    source:
      'const other = { run: () => 1 };\nconst handlers = { run: 0 as unknown as () => number };\nfunction invoke() { return handlers.run(); }\nother.run = () => 2;\n',
    throws: true,
  },
  {
    callee: 'handlers.run',
    id: 'a member read where it is declared, written later',
    source:
      'const handlers = { run: 0 as unknown as () => number };\nhandlers.run();\nhandlers.run = () => 1;\n',
    throws: true,
  },
  {
    callee: 'handlers.run',
    id: 'a member read in a function, written before it',
    source:
      'const handlers = { run: 0 as unknown as () => number };\nhandlers.run = () => 1;\nfunction invoke() { return handlers.run(); }\n',
    throws: false,
  },
  {
    callee: 'handlers.run',
    id: 'a method',
    source:
      'const handlers = { run() { return 1; } };\nfunction invoke() { return handlers.run(); }\nhandlers.run = () => 2;\n',
    throws: false,
  },
];

describe('a literal member called in a function written before a write to the literal', () => {
  it.each(ROWS)('$id', ({ callee, source, throws }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'deferred-writes.ts', source);

    expect(invocationThrows(callIn(parsed.sourceFile, callee), undefined)).toBe(throws);
  });
});

/** A call that reads an optional member of a literal, and whether its callee surely is nullish. */
interface Optional {
  readonly id: string;
  readonly source: string;
  readonly nullish: boolean;
}

const OPTIONAL: readonly Optional[] = [
  {
    id: 'a member replaced after the function that reads it',
    nullish: false,
    source:
      'const handlers: { run?: () => number } = {};\nfunction invoke() { return handlers.run?.(); }\nhandlers.run = () => 1;\n',
  },
  {
    id: 'a member no code writes',
    nullish: true,
    source:
      'const handlers: { run?: () => number } = {};\nfunction invoke() { return handlers.run?.(); }\n',
  },
];

describe('an optional call of a literal member written after the function that calls it', () => {
  it.each(OPTIONAL)('$id', ({ nullish, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'deferred-optional.ts', source);
    const call = callIn(parsed.sourceFile, 'handlers.run');

    expect(nullishCallee(call.expression, undefined)).toBe(nullish);
  });
});

/** The first call in `root` whose callee is written as `callee`. */
function callIn(root: Node, callee: string): CallExpression {
  const found: CallExpression[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node) && textOf(node.expression) === callee) {
      found.push(node);
    }
    node.forEachChild(visit);
  };
  visit(root);
  const [first] = found;
  if (first === undefined) {
    throw new Error(`The fixture calls ${callee}.`);
  }
  return first;
}

/** What a callee is written as, an optional call's question mark left out. */
function textOf(expression: Expression): string {
  return expression.getText();
}
