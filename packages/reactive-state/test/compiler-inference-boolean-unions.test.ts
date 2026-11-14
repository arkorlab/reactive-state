import {
  isConditionalTypeNode,
  isLiteralTypeNode,
  isStringLiteral,
  isTypeAliasDeclaration,
  isUnionTypeNode,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialTypeReading, type TypeReading } from '../src/compiler/local-type-environment.ts';
import type { Bindings } from '../src/compiler/local-type-inference-types.ts';
import { inferPattern } from '../src/compiler/local-type-inference.ts';

/**
 * TypeScript reads `boolean` as `true | false`, each of whose literals meets an arm of a union
 * pattern on its own: `boolean extends string | infer U` binds `U` to `boolean`, and
 * `boolean extends true | infer U` to `false`, both in the true branch alone. Each row's
 * alternatives hold TypeScript 7.1's binding among those the matcher keeps. The rows without
 * inference pin the collective match the change leaves as it was, uncertain of a keyword arm.
 */
const CASES = [
  {
    extended: 'string | infer U',
    matches: true,
    alternatives: ['U=false | true'],
    what: 'an arm the literals do not meet',
  },
  {
    extended: 'true | infer U',
    matches: true,
    alternatives: ['U=false', 'U=false | true'],
    what: 'an arm one literal meets',
  },
  {
    extended: 'boolean | infer U',
    matches: true,
    alternatives: ['', 'U=false', 'U=false | true', 'U=true'],
    what: 'an arm both literals meet',
  },
  {
    extended: 'true | false',
    matches: true,
    alternatives: [''],
    what: 'both literals without inference',
  },
  {
    extended: 'true | string',
    matches: undefined,
    alternatives: [''],
    what: 'one literal without inference',
  },
] as const;

/** The primitive a written type names, as far as the stand-in relation below reads it. */
function primitive(type: TypeReading['type']): string | undefined {
  if (isLiteralTypeNode(type)) {
    if (type.literal.kind === SyntaxKind.TrueKeyword) return 'true';
    if (type.literal.kind === SyntaxKind.FalseKeyword) return 'false';
    return isStringLiteral(type.literal) ? 'string' : undefined;
  }
  if (type.kind === SyntaxKind.BooleanKeyword) return 'boolean';
  return type.kind === SyntaxKind.StringKeyword ? 'string' : undefined;
}

/** A stand-in for the compiler's relation of two primitives; others it leaves unknown. */
function related(actual: TypeReading, expected: TypeReading): boolean | undefined {
  const source = primitive(actual.type);
  const target = primitive(expected.type);
  if (source === undefined || target === undefined) return undefined;
  if (target === 'boolean') return source !== 'string';
  return source === target;
}

/** A synthetic union of boolean's literals, or an original node, as written. */
function written(type: TypeReading['type']): string {
  if (isUnionTypeNode(type))
    return type.types
      .map((each: TypeNode) => written(each))
      .toSorted((left, right) => left.localeCompare(right))
      .join(' | ');
  if (isLiteralTypeNode(type) && type.literal.kind === SyntaxKind.TrueKeyword) return 'true';
  if (isLiteralTypeNode(type) && type.literal.kind === SyntaxKind.FalseKeyword) return 'false';
  return type.getText();
}

/** One alternative's inferred parameters and their values, as written. */
function printed(bindings: Bindings): string {
  return [...bindings]
    .map(([parameter, value]) => `${parameter.name.text}=${written(value.type)}`)
    .join(', ');
}

describe('boolean against a union pattern', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The matcher's answer for `boolean extends extended`, and each alternative's bindings. */
  function matched(extended: string): {
    readonly matches: boolean | undefined;
    readonly alternatives: readonly string[];
  } {
    using parsed = api.createSourceFile(
      'boolean-unions.ts',
      `type Check = boolean extends ${extended} ? 1 : 0;\n`,
    );
    const [statement] = parsed.sourceFile.statements;
    const conditional =
      statement !== undefined && isTypeAliasDeclaration(statement) ? statement.type : undefined;
    if (conditional === undefined || !isConditionalTypeNode(conditional)) {
      throw new Error(`No conditional is declared of ${extended}.`);
    }
    const result = inferPattern(
      initialTypeReading(conditional.checkType),
      initialTypeReading(conditional.extendsType),
      (reading) => reading,
      related,
    );
    return {
      matches: result.matches,
      alternatives: result.alternatives
        .map((bindings) => printed(bindings))
        .toSorted((left, right) => left.localeCompare(right)),
    };
  }

  it.each(CASES)('$what', ({ extended, matches, alternatives }) => {
    expect(matched(extended)).toStrictEqual({ matches, alternatives });
  });
});
