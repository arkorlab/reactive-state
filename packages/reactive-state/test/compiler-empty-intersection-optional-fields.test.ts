import {
  isConditionalTypeNode,
  isIdentifier,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  type TypeAliasDeclaration,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  boundTypeBody,
  initialTypeReading,
  type TypeReading,
} from '../src/compiler/local-type-environment.ts';
import { inferPattern } from '../src/compiler/local-type-inference.ts';

/**
 * An optional field's type holds `undefined` too, and TypeScript reduces an intersection of object
 * types to `never` only for a required field one of whose suppliers is a literal type — every value
 * of it a unit, `undefined` among them for an optional supplier — and whose types share no value.
 * Each row is what TypeScript 7.1 answers for `Source extends { missing: number }`: `true` where the
 * intersection is `never`, `false` where it is an object, which has no `missing` field. The rows the
 * matcher answered so before pin the forms the change must keep.
 */
const CASES = [
  {
    source: "{ k?: 'a' } & { k: undefined }",
    matches: false,
    what: 'an undefined by an optional literal',
  },
  {
    source: "{ k?: 'a' } & { k: undefined | 'b' }",
    matches: false,
    what: 'an undefined arm by an optional literal',
  },
  {
    source: '{ k?: never } & { k: string }',
    matches: true,
    what: 'an optional never beside a wide type',
  },
  {
    source: "{ k?: never } & { k: 'a' }",
    matches: true,
    what: 'an optional never beside a literal',
  },
  {
    source: "{ k: 'a' | string } & { k: number }",
    matches: false,
    what: 'a literal a wide type absorbs',
  },
  { source: '{ k?: string } & { k: number }', matches: false, what: 'an optional wide type' },
  {
    source: '{ k?: string } & { k?: number } & { k: number }',
    matches: false,
    what: 'optional wide types',
  },
  { source: "{ k?: 'a' } & { k: 'b' }", matches: true, what: 'disjoint literals, one optional' },
  { source: "{ k?: 'a' } & { k: 'a' }", matches: false, what: 'the same literal, one optional' },
  { source: '{ k?: undefined } & { k: string }', matches: true, what: 'an optional undefined' },
  { source: '{ k?: boolean } & { k: string }', matches: true, what: 'an optional boolean' },
  { source: "{ k?: 'a' } & { k?: 'b' }", matches: false, what: 'optional fields alone' },
] as const;

describe('an optional field in an intersection of object types', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The matcher's answer for `Source extends { missing: number }`, with local aliases followed. */
  function matched(source: string): boolean | undefined {
    using parsed = api.createSourceFile(
      'optional-fields.ts',
      `type Source = ${source};\ntype Check = Source extends { missing: number } ? true : false;\n`,
    );
    const declarations = new Map<string, TypeAliasDeclaration>();
    for (const statement of parsed.sourceFile.statements) {
      if (isTypeAliasDeclaration(statement)) declarations.set(statement.name.text, statement);
    }
    const conditional = declarations.get('Check')?.type;
    if (conditional === undefined || !isConditionalTypeNode(conditional)) {
      throw new Error('No conditional Check is declared.');
    }
    const resolve = (at: TypeReading): TypeReading | undefined => {
      let reading = at;
      while (isTypeReferenceNode(reading.type) && isIdentifier(reading.type.typeName)) {
        const declaration = declarations.get(reading.type.typeName.text);
        if (declaration === undefined) return reading;
        const bound = boundTypeBody(declaration, reading.type, reading);
        if (bound === undefined) return undefined;
        reading = { ...bound, type: declaration.type };
      }
      return reading;
    };
    return inferPattern(
      initialTypeReading(conditional.checkType),
      initialTypeReading(conditional.extendsType),
      resolve,
      // A stand-in relation that knows only a written type's identity with itself.
      (actual, expected) => (actual.type === expected.type ? true : undefined),
    ).matches;
  }

  it.each(CASES)('$what', ({ source, matches }) => {
    expect(matched(source)).toBe(matches);
  });
});
