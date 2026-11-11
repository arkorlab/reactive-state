import {
  isExpressionWithTypeArguments,
  isIdentifier,
  isNewExpression,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { localClassValueBinding } from '../src/compiler/local-type-aliases.ts';

/**
 * A `var` is its namespace's function's, as a function's is its own: one of a block of the body is
 * the body's, one of a namespace nested in the body is that namespace's. The name a class extends
 * is the global's where no declaration in scope gives it, past a `var` of a namespace within the
 * namespace the class stands in.
 */

const CASES = [
  {
    lines: [
      'namespace Outer {',
      '  namespace Inner {',
      '    export var Error = 1;',
      '  }',
      '  export class Failure extends Error {}',
      '}',
    ],
    reads: ['5:none'],
    what: "a var of a namespace nested in the class's",
  },
  {
    lines: [
      'namespace Outer {',
      '  namespace Inner {',
      '    export namespace Deep {',
      '      export var Error = 1;',
      '    }',
      '  }',
      '  export class Failure extends Error {}',
      '}',
    ],
    reads: ['7:none'],
    what: "a var of a namespace two within the class's",
  },
  {
    lines: [
      'namespace Outer {',
      '  namespace Inner {',
      '    export var Error = 1;',
      '    export class Failure extends Error {}',
      '  }',
      '}',
    ],
    reads: ['4:value'],
    what: "a var of the namespace the class stands in, which is that namespace's",
  },
  {
    lines: [
      'namespace Outer {',
      '  {',
      '    var Error = 1;',
      '  }',
      '  export class Failure extends Error {}',
      '}',
    ],
    reads: ['5:value'],
    what: "a var of a block of the namespace's body",
  },
  {
    lines: [
      'namespace Outer {',
      '  export var Error = 1;',
      '  export class Failure extends Error {}',
      '}',
    ],
    reads: ['3:value'],
    what: "a var of the namespace's body",
  },
  {
    lines: [
      'namespace Outer {',
      '  export function make() {',
      '    var Error = 1;',
      '    return Error;',
      '  }',
      '  export class Failure extends Error {}',
      '}',
    ],
    reads: ['6:none'],
    what: "a var of a function of the namespace's body",
  },
] as const;

describe("a var of a namespace's body in the lookup of a value", () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What the lookup finds of each `Error` a class extends or a `new` makes: `line:none`, `line:value` (a binding that is no class) or `line:class`. */
  function foundIn(lines: readonly string[]): readonly string[] {
    using parsed = api.createSourceFile('hoisted.ts', `${lines.join('\n')}\n`);
    const { sourceFile } = parsed;
    const found: string[] = [];
    const visit = (node: Node): void => {
      const named =
        isExpressionWithTypeArguments(node) || isNewExpression(node) ? node.expression : undefined;
      if (named !== undefined && isIdentifier(named) && named.text === 'Error') {
        const binding = localClassValueBinding(named);
        const { line } = sourceFile.getLineAndCharacterOfPosition(named.getStart(sourceFile));
        let what = 'class';
        if (binding === undefined) {
          what = 'none';
        } else if (binding === null) {
          what = 'value';
        }
        found.push(`${String(line + 1)}:${what}`);
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    return found;
  }

  it.each(CASES)('finds the global past $what', ({ lines, reads }) => {
    expect(foundIn(lines)).toStrictEqual(reads);
  });
});
