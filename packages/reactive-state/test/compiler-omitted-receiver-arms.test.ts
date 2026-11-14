import {
  isIdentifier,
  isParenthesizedTypeNode,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isUnionTypeNode,
  type TypeAliasDeclaration,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  boundTypeBody,
  initialTypeReading,
  type TypeReading,
} from '../src/compiler/local-type-environment.ts';
import { omittedReceiverReadings } from '../src/compiler/local-type-omitted-receivers.ts';

/**
 * `OmitThisParameter` of a union removes each arm's receiver: an arm whose own generic receiver the
 * reader cannot remove keeps its written type beside the others, rather than the others standing
 * alone for the whole operand. A union of arms each omitted, and one such arm alone, which reads as
 * no type, pin what the change keeps.
 */
const CASES = [
  {
    declarations:
      'type Arms = (<T extends Window>(this: T) => Error) | ((this: Window) => string);\ntype Target = OmitThisParameter<Arms>;',
    readings: ['<T extends Window>(this: T) => Error', 'omitted'],
    what: 'an arm whose receiver stays',
  },
  {
    declarations:
      'type Arms = ((this: Window) => Error) | ((this: Window) => string);\ntype Target = OmitThisParameter<Arms>;',
    readings: ['omitted', 'omitted'],
    what: 'arms each omitted',
  },
  {
    declarations:
      'type Arm = <T extends Window>(this: T) => Error;\ntype Target = OmitThisParameter<Arm>;',
    readings: [],
    what: 'one such arm alone',
  },
] as const;

describe("the omitted receivers of a union's arms", () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `OmitThisParameter` of `Target`'s argument reads as: a kept type as written, or `omitted`. */
  function omitted(declarations: string): readonly string[] | undefined {
    using parsed = api.createSourceFile('omitted-receivers.ts', `${declarations}\n`);
    const aliases = new Map<string, TypeAliasDeclaration>();
    for (const statement of parsed.sourceFile.statements) {
      if (isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement);
    }
    const target = aliases.get('Target')?.type;
    if (target === undefined) throw new Error('No Target is declared.');
    // A stand-in for the compiler's operands: aliases, parentheses and union arms; `Unread` resolves
    // to nothing, as a name the compiler cannot follow does.
    const operands = (at: TypeReading): readonly TypeReading[] => {
      const result: TypeReading[] = [];
      const pending = [at];
      for (let reading = pending.pop(); reading !== undefined; reading = pending.pop()) {
        const { type } = reading;
        if (isParenthesizedTypeNode(type)) pending.push({ ...reading, type: type.type });
        else if (isUnionTypeNode(type))
          pending.push(...type.types.map((each) => ({ ...reading, type: each })));
        else if (isTypeReferenceNode(type) && isIdentifier(type.typeName)) {
          const declaration = aliases.get(type.typeName.text);
          const bound =
            declaration === undefined ? undefined : boundTypeBody(declaration, type, reading);
          if (declaration !== undefined && bound !== undefined)
            pending.push({ ...bound, type: declaration.type });
          else if (type.typeName.text !== 'Unread') result.push(reading);
        } else result.push(reading);
      }
      return result;
    };
    return omittedReceiverReadings(initialTypeReading(target), operands)
      ?.map((reading) => (reading.type.pos >= 0 ? reading.type.getText() : 'omitted'))
      .toSorted((left, right) => left.localeCompare(right));
  }

  it.each(CASES)('$what', ({ declarations, readings }) => {
    expect(omitted(declarations)).toStrictEqual(readings);
  });
});
