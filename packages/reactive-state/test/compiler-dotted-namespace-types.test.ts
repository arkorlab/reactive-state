import {
  isClassDeclaration,
  isClassExpression,
  isIdentifier,
  isInterfaceDeclaration,
  isNewExpression,
  isQualifiedName,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { localClassValueBinding, localTypeBinding } from '../src/compiler/local-type-aliases.ts';
import { qualifiedLocalTypeBinding } from '../src/compiler/local-type-namespaces.ts';

/**
 * `namespace Outer.Inner {}` is `namespace Outer { export namespace Inner {} }`: a type, a class or a
 * namespace a name in `Inner`'s body stands for is what the body declares, what the other bodies of
 * `Inner` export, what the bodies of `Outer` export — `Outer`'s body here is `Inner` alone — and
 * then the module's. What `Outer` keeps to itself, and another namespace's, is no part of it, and
 * a name the lookup finds in none of them is a global's.
 */

const CASES = [
  {
    lines: [
      'namespace Outer {',
      '  export type Probe = number;',
      '}',
      'namespace Outer.Inner {',
      '  export const value: Probe = 1;',
      '}',
    ],
    reads: ['type alias'],
    what: 'an alias the outer namespace exports',
  },
  {
    lines: [
      'namespace Outer {',
      '  export interface Probe {',
      '    readonly sides: number;',
      '  }',
      '}',
      'namespace Outer.Inner {',
      '  export const value: Probe = { sides: 3 };',
      '}',
    ],
    reads: ['type interface'],
    what: 'an interface the outer namespace exports',
  },
  {
    lines: [
      'namespace Outer {',
      '  export class Probe {}',
      '}',
      'namespace Outer.Inner {',
      '  export const value: Probe = new Probe();',
      '}',
    ],
    reads: ['type class', 'value class'],
    what: 'a class the outer namespace exports, as a type and as a value',
  },
  {
    lines: [
      'namespace Outer.Inner {',
      '  export const value: Probe = 1;',
      '}',
      'namespace Outer {',
      '  export type Probe = number;',
      '}',
    ],
    reads: ['type alias'],
    what: 'an alias a later body of the outer namespace exports',
  },
  {
    lines: [
      'namespace Outer {',
      '  export type Probe = number;',
      '}',
      'namespace Outer.Mid.Inner {',
      '  export const value: Probe = 1;',
      '}',
    ],
    reads: ['type alias'],
    what: 'an alias the outermost namespace exports, in a body of three names',
  },
  {
    lines: [
      'namespace Outer.Mid {',
      '  export type Probe = number;',
      '}',
      'namespace Outer.Mid.Inner {',
      '  export const value: Probe = 1;',
      '}',
    ],
    reads: ['type alias'],
    what: 'an alias the middle namespace exports, in a body of three names',
  },
  {
    lines: [
      'namespace Outer {',
      '  export namespace Shapes {',
      '    export type Probe = number;',
      '  }',
      '}',
      'namespace Outer.Inner {',
      '  export const value: Shapes.Probe = 1;',
      '}',
    ],
    reads: ['qualified alias'],
    what: 'a namespace the outer namespace exports, named in a qualified type',
  },
  {
    lines: [
      'namespace Outer {',
      '  type Probe = number;',
      '}',
      'namespace Outer.Inner {',
      '  export const value: Probe = 1;',
      '}',
    ],
    reads: ['type none'],
    what: 'an alias the outer namespace keeps to itself',
  },
  {
    lines: [
      'namespace Other {',
      '  export type Probe = number;',
      '}',
      'namespace Outer.Inner {',
      '  export const value: Probe = 1;',
      '}',
    ],
    reads: ['type none'],
    what: "another namespace's exported alias",
  },
  {
    lines: [
      'namespace Outer {',
      '  export type Probe = number;',
      '}',
      'namespace Outer.Inner {',
      '  export type Probe = string;',
      '  export const value: Probe = "";',
      '}',
    ],
    reads: ['type alias'],
    what: "an alias of the inner namespace's own, beside the outer one's",
  },
  {
    lines: [
      'type Probe = number;',
      'namespace Outer.Inner {',
      '  export const value: Probe = 1;',
      '}',
    ],
    reads: ['type alias'],
    what: "the module's alias",
  },
] as const;

/** What a lookup of a reference found: its kind, then `alias`, `interface`, `class` or `none`. */
function describeFound(kind: string, found: Node | null | undefined): string {
  let what = 'none';
  if (found !== undefined && found !== null) {
    if (isTypeAliasDeclaration(found)) {
      what = 'alias';
    } else if (isInterfaceDeclaration(found)) {
      what = 'interface';
    } else if (isClassDeclaration(found) || isClassExpression(found)) {
      what = 'class';
    } else {
      what = 'other';
    }
  }
  return `${kind} ${what}`;
}

describe('a name read in a namespace of a dotted name, of what the outer namespace exports', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What the lookups find for each use of `Probe` in the module `lines`, in the order written. */
  function foundIn(lines: readonly string[]): readonly string[] {
    using parsed = api.createSourceFile('dotted.ts', `${lines.join('\n')}\n`);
    const found: string[] = [];
    const visit = (node: Node): void => {
      if (isTypeReferenceNode(node)) {
        const { typeName } = node;
        if (isIdentifier(typeName) && typeName.text === 'Probe') {
          found.push(describeFound('type', localTypeBinding(typeName)));
        } else if (isQualifiedName(typeName) && typeName.right.text === 'Probe') {
          found.push(describeFound('qualified', qualifiedLocalTypeBinding(typeName)));
        }
      }
      if (
        isNewExpression(node) &&
        isIdentifier(node.expression) &&
        node.expression.text === 'Probe'
      ) {
        found.push(describeFound('value', localClassValueBinding(node.expression)));
      }
      node.forEachChild(visit);
    };
    parsed.sourceFile.forEachChild(visit);
    return found;
  }

  it.each(CASES)('finds $what', ({ lines, reads }) => {
    expect(foundIn(lines)).toStrictEqual(reads);
  });
});
