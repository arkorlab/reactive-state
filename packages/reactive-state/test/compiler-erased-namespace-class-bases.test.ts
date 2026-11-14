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
 * A namespace of types alone emits no value, so the name it shares with a class base is the base's:
 * the built-in `Error` of `class Failure extends Error {}` stays the built-in beside `namespace
 * Error { export type Tag = string; }`. A namespace that holds a value, an exported alias among
 * them, is that value, and keeps the name opaque; a class or a constant it is merged with is read
 * as it is, whichever comes first.
 */

const ERASED_BODIES = [
  { body: 'export type Tag = string;', what: 'a type alias' },
  { body: 'export interface Tag {}', what: 'an interface' },
  { body: '', what: 'an empty body' },
  {
    body: 'export namespace Tags {\n  export type Tag = string;\n}',
    what: 'a namespace of types',
  },
  { body: 'import Tag = Types.Tag;', what: 'an alias it does not export' },
] as const;

const VALUE_BODIES = [
  { body: 'export const tag = 1;', what: 'a constant' },
  { body: 'export function tag() {}', what: 'a function' },
  { body: 'export class Tag {}', what: 'a class' },
  { body: 'export enum Tag {\n  A,\n}', what: 'an enum' },
  { body: 'export import Tag = Types.Tag;', what: 'an alias it exports' },
  {
    body: 'export namespace Tags {\n  export const tag = 1;\n}',
    what: 'a namespace of a value',
  },
] as const;

const MERGED = [
  {
    binding: 'ClassDeclaration',
    source:
      'namespace Error {\n  export type Tag = string;\n}\nclass Error {}\nclass Failure extends Error {}',
    what: 'a namespace of types before the class it is merged with',
  },
  {
    binding: 'ClassDeclaration',
    source:
      'class Error {}\nnamespace Error {\n  export type Tag = string;\n}\nclass Failure extends Error {}',
    what: 'a namespace of types after the class it is merged with',
  },
  {
    binding: 'VariableDeclaration',
    source:
      'namespace Error {\n  export type Tag = string;\n}\nconst Error = class {};\nclass Failure extends Error {}',
    what: 'a namespace of types before a constant of its name',
  },
  {
    binding: 'opaque',
    source:
      'namespace Error {\n  export type Tag = string;\n}\nnamespace Error {\n  export const tag = 1;\n}\nclass Failure extends Error {}',
    what: 'a namespace of types merged with another that holds a value',
  },
  {
    binding: 'none',
    source:
      'namespace Outer {\n  export namespace Error {\n    export type Tag = string;\n  }\n}\nnamespace Outer.Inner {\n  export class Failure extends Error {}\n}',
    what: 'a namespace of types of an outer namespace, read from a dotted one',
  },
  {
    binding: 'opaque',
    source:
      'namespace Outer {\n  export namespace Error {\n    export const tag = 1;\n  }\n}\nnamespace Outer.Inner {\n  export class Failure extends Error {}\n}',
    what: 'a namespace of a value of an outer namespace, read from a dotted one',
  },
  {
    binding: 'none',
    source:
      'export {};\nnamespace Types {\n  export type Tag = string;\n}\nnamespace Error {\n  import Tag = Types.Tag;\n}\nclass Failure extends Error {}',
    what: 'a namespace of an import alone',
  },
] as const;

/** The source of a namespace `Error` holding `body`, and the class that extends it. */
function namespaceOf(body: string): string {
  return [
    'export {};',
    'namespace Types {\n  export type Tag = string;\n}',
    `namespace Error {\n${body.replaceAll(/^/gmu, '  ')}\n}`,
    'class Failure extends Error {}',
  ].join('\n');
}

describe('a class base a namespace of types alone shares its name with', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `localClassValueBinding` answers of the base of the class `Failure` of `source`. */
  function bindingOf(source: string): string {
    using parsed = api.createSourceFile('bases.ts', `${source}\n`);
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

  it.each(ERASED_BODIES)('leaves the built-in where it holds $what alone', ({ body }) => {
    expect(bindingOf(namespaceOf(body))).toBe('none');
  });

  it.each(VALUE_BODIES)('is a value where it holds $what', ({ body }) => {
    expect(bindingOf(namespaceOf(body))).toBe('opaque');
  });

  it.each(MERGED)('reads $what', ({ binding, source }) => {
    expect(bindingOf(source)).toBe(binding);
  });
});
