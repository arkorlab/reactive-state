import { isTypeAliasDeclaration } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialTypeReading } from '../src/compiler/local-type-environment.ts';
import { actualQueryArgument } from '../src/compiler/local-type-query-argument-scope.ts';

/**
 * A query argument is an actual one only if it is written out whole: a `typeof` anywhere in it, or
 * in the body of a local type it names, leaves it unread. A name qualified through namespaces is
 * followed to its body as an unqualified name is, so `NS.Alias` of `typeof data` is no more closed
 * than `Alias` is.
 */

const CASES = [
  {
    what: 'an unqualified alias of a type query (a pin)',
    source: 'declare const data: Error;\ntype Alias = typeof data;\ntype Selected = Alias;',
    closed: false,
  },
  {
    what: 'a qualified alias of a type query',
    source:
      'declare const data: Error;\nnamespace NS { export type Alias = typeof data; }\ntype Selected = NS.Alias;',
    closed: false,
  },
  {
    what: 'an alias of a type query two namespaces down',
    source:
      'declare const data: Error;\nnamespace A { export namespace B { export type Alias = typeof data; } }\ntype Selected = A.B.Alias;',
    closed: false,
  },
  {
    what: 'a qualified generic alias whose body holds a type query',
    source:
      'declare const data: Error;\nnamespace NS { export type Box<T> = { value: T; query: typeof data }; }\ntype Selected = NS.Box<string>;',
    closed: false,
  },
  {
    what: 'a qualified interface with a member of a type query',
    source:
      'declare const data: Error;\nnamespace NS { export interface Shape { value: typeof data; } }\ntype Selected = NS.Shape;',
    closed: false,
  },
  {
    what: 'a qualified alias of a type query inside an argument',
    source:
      'declare const data: Error;\nnamespace NS { export type Alias = typeof data; }\ntype Selected = Array<NS.Alias>;',
    closed: false,
  },
  {
    what: 'a qualified alias reached through an unqualified one',
    source:
      'declare const data: Error;\nnamespace NS { export type Alias = typeof data; }\ntype Through = NS.Alias;\ntype Selected = Through;',
    closed: false,
  },
  {
    what: 'a qualified closed alias (a pin)',
    source: 'namespace NS { export type Alias = string[]; }\ntype Selected = NS.Alias;',
    closed: true,
  },
  {
    what: 'a qualified generic alias with its argument written (a pin)',
    source:
      'namespace NS { export type Box<T> = { value: T }; }\ntype Selected = NS.Box<{ stack: string }>;',
    closed: true,
  },
  {
    what: 'a qualified alias of a name outside the file (a pin)',
    source: "import * as NS from './elsewhere';\ntype Selected = NS.Alias;",
    closed: true,
  },
  {
    what: 'a qualified built-in name (a pin)',
    source: 'type Selected = Intl.DateTimeFormat;',
    closed: true,
  },
] as const;

describe('a qualified name in a query argument', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `Selected`, as the file declares it, is a query argument written out whole. */
  function closedOf(source: string): boolean {
    using parsed = api.createSourceFile('query-arguments.ts', source);
    const declaration = parsed.sourceFile.statements.find(
      (statement) => isTypeAliasDeclaration(statement) && statement.name.text === 'Selected',
    );
    if (declaration === undefined || !isTypeAliasDeclaration(declaration)) {
      throw new Error('the argument was not parsed');
    }
    return actualQueryArgument(initialTypeReading(declaration.type));
  }

  it.each(CASES)('$what', ({ source, closed }) => {
    expect(closedOf(source)).toBe(closed);
  });
});
