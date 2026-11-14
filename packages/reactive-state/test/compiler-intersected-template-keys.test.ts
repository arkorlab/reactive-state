import {
  isIdentifier,
  isLiteralTypeNode,
  isParenthesizedTypeNode,
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
import { intersectedIndexReadings } from '../src/compiler/local-type-intersected-indices.ts';
import { literalKey } from '../src/compiler/local-type-utility-readings.ts';

/**
 * A template without substitutions, `` `a` ``, is the string `'a'`: an intersection of finite keys
 * keeps it where another part keeps `'a'`, as TypeScript's `{ a: 1; b: 2 }[Keys]` reads both members
 * of ``(`a` | 'b') & ('a' | 'b')``. The row of string literals alone pins the selection the change
 * leaves as it was.
 */
const CASES = [
  { keys: "(`a` | 'b') & ('a' | 'b')", selected: ['a', 'b'], what: 'a template beside a literal' },
  { keys: "`a` & 'a'", selected: ['a'], what: 'a template and its literal' },
  { keys: "('a' | 'b') & ('b' | 'c')", selected: ['b'], what: 'string literals alone' },
] as const;

describe('a template key in an intersection of finite keys', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The keys `intersectedIndexReadings` selects of `Keys`, or none where it leaves them open. */
  function selected(keys: string): readonly string[] | undefined {
    using parsed = api.createSourceFile('template-keys.ts', `type Keys = ${keys};\n`);
    const aliases = new Map<string, TypeAliasDeclaration>();
    for (const statement of parsed.sourceFile.statements) {
      if (isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement);
    }
    const written = aliases.get('Keys')?.type;
    if (written === undefined) throw new Error('No Keys is declared.');
    // The compiler's own resolver follows local aliases and parentheses alike.
    const resolve = (at: TypeReading): TypeReading | undefined => {
      let reading = at;
      for (;;) {
        const { type } = reading;
        if (isParenthesizedTypeNode(type)) {
          reading = { ...reading, type: type.type };
          continue;
        }
        if (!isTypeReferenceNode(type) || !isIdentifier(type.typeName)) return reading;
        const declaration = aliases.get(type.typeName.text);
        if (declaration === undefined) return reading;
        const bound = boundTypeBody(declaration, type, reading);
        if (bound === undefined) return undefined;
        reading = { ...bound, type: declaration.type };
      }
    };
    return intersectedIndexReadings(initialTypeReading(written), resolve)
      ?.map((reading) => (isLiteralTypeNode(reading.type) ? literalKey(reading.type) : '?') ?? '?')
      .toSorted((left, right) => left.localeCompare(right));
  }

  it.each(CASES)('$what', ({ keys, selected: expected }) => {
    expect(selected(keys)).toStrictEqual(expected);
  });
});
