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
 * A `var` of a namespace is the namespace's own: one of a namespace within another is not the
 * other's, however the other is written. In `namespace A.B { namespace C { var Base = 1; } class
 * Failure extends Base {} }` the `Base` of the class is read where `C`'s `var` is not in scope, as
 * it is where `A` is written beside `B` in a block of its own. A `var` of `B` itself is its own.
 */

const CASES = [
  {
    binding: 'ClassDeclaration',
    lines: [
      'class Base {}',
      'namespace A.B {',
      '  namespace C {',
      '    var Base = 1;',
      '  }',
      '  export class Failure extends Base {}',
      '}',
    ],
    what: 'a var of a namespace within a dotted namespace',
  },
  {
    binding: 'ClassDeclaration',
    lines: [
      'class Base {}',
      'namespace A.B.C {',
      '  namespace D {',
      '    var Base = 1;',
      '  }',
      '  export class Failure extends Base {}',
      '}',
    ],
    what: 'a var of a namespace within a namespace of three names',
  },
  {
    binding: 'none',
    lines: [
      'namespace A.B {',
      '  namespace C {',
      '    var Error = class {};',
      '  }',
      '  export class Failure extends Error {}',
      '}',
    ],
    what: 'a var of a namespace within a dotted namespace, of a built-in',
  },
  {
    binding: 'none',
    lines: [
      'namespace A.B {',
      '  namespace C {',
      '    {',
      '      var Error = class {};',
      '    }',
      '  }',
      '  export class Failure extends Error {}',
      '}',
    ],
    what: "a var in a block of a namespace within a dotted namespace's",
  },
  {
    binding: 'ClassDeclaration',
    lines: [
      'class Base {}',
      'namespace A {',
      '  namespace C {',
      '    var Base = 1;',
      '  }',
      '  export class Failure extends Base {}',
      '}',
    ],
    what: 'a var of a namespace within a namespace',
  },
  {
    binding: 'opaque',
    lines: [
      'class Base {}',
      'namespace A.B {',
      '  var Base = 1;',
      '  export class Failure extends Base {}',
      '}',
    ],
    what: "a dotted namespace's own var",
  },
  {
    binding: 'opaque',
    lines: [
      'class Base {}',
      'namespace A.B {',
      '  {',
      '    var Base = 1;',
      '  }',
      '  export class Failure extends Base {}',
      '}',
    ],
    what: "a var in a block of a dotted namespace's",
  },
  {
    binding: 'opaque',
    lines: [
      'class Base {}',
      'namespace A.B.C {',
      '  var Base = 1;',
      '  export class Failure extends Base {}',
      '}',
    ],
    what: "the last of three names' own var",
  },
] as const;

describe('a class base a var of a namespace within a dotted namespace names', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `localClassValueBinding` answers of the base of the class `Failure` of `lines`. */
  function bindingOf(lines: readonly string[]): string {
    using parsed = api.createSourceFile('namespaces.ts', `${lines.join('\n')}\n`);
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
