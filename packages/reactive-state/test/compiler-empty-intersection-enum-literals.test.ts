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
 * TypeScript keeps an enum member's type apart from a plain literal of the same value, as from a
 * member of another enum: `{ k: E.A } & { k: 'a' }` of `enum E { A = 'a' }` is `never`, which the
 * reader cannot tell from its values alone, and leaves uncertain rather than call it an object.
 * Each row is the matcher's answer for `Source extends { missing: number }`; the rows that the old
 * reading already answered so pin what the change keeps.
 */
const CASES = [
  {
    declarations: "enum E { A = 'a', B = 'b' }",
    source: "{ k: E.A } & { k: 'a' }",
    matches: undefined,
    what: 'a string member and its literal',
  },
  {
    declarations: 'enum N { A = 1 }',
    source: '{ k: N.A } & { k: 1 }',
    matches: undefined,
    what: 'a numeric member and its literal',
  },
  {
    declarations: "enum E { A = 'a', B = 'b' }",
    source: "{ k: E.A } & { k: 'a' | 'b' }",
    matches: undefined,
    what: 'a member and a union of literals',
  },
  {
    declarations: "enum E { A = 'a', B = 'b' }",
    source: '{ k: E.A } & { k: E.B }',
    matches: true,
    what: 'two members of one enum',
  },
  {
    declarations: "enum E { A = 'a', B = 'b' }",
    source: '{ k: E.A } & { k: E.A }',
    matches: false,
    what: 'one member twice',
  },
  {
    declarations: "enum E { A = 'a', B = 'b' }",
    source: '{ k: E.A } & { k: string }',
    matches: false,
    what: 'a member beside its wide type',
  },
  {
    declarations: "enum E { A = 'a', B = 'b' }",
    source: "{ k: 'a' } & { k: 'a' }",
    matches: false,
    what: 'one plain literal twice',
  },
] as const;

describe('an enum member beside a plain literal', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The matcher's answer for `Source extends { missing: number }`, with local aliases followed. */
  function matched(declarations: string, source: string): boolean | undefined {
    using parsed = api.createSourceFile(
      'enum-fields.ts',
      `${declarations}\ntype Source = ${source};\ntype Check = Source extends { missing: number } ? true : false;\n`,
    );
    const aliases = new Map<string, TypeAliasDeclaration>();
    for (const statement of parsed.sourceFile.statements) {
      if (isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement);
    }
    const conditional = aliases.get('Check')?.type;
    if (conditional === undefined || !isConditionalTypeNode(conditional)) {
      throw new Error('No conditional Check is declared.');
    }
    const resolve = (at: TypeReading): TypeReading | undefined => {
      let reading = at;
      while (isTypeReferenceNode(reading.type) && isIdentifier(reading.type.typeName)) {
        const declaration = aliases.get(reading.type.typeName.text);
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

  it.each(CASES)('$what', ({ declarations, source, matches }) => {
    expect(matched(declarations, source)).toBe(matches);
  });
});
