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
 * `OmitThisParameter` takes the last call signature a callable writes, which a base interface or an
 * intersected member the reader cannot resolve may supply: there the operand keeps its written type,
 * generic or not, rather than lose the receiver of a signature that may not be the last. A resolved
 * intersection and interface pin what the change keeps.
 */
const CASES = [
  {
    declarations: 'type Target = OmitThisParameter<((this: Window) => Error) & Unread>;',
    readings: ['((this: Window) => Error) & Unread'],
    what: 'an intersected member it cannot read',
  },
  {
    declarations:
      'interface Call extends Imported { (this: Window): Error }\ntype Target = OmitThisParameter<Call>;',
    readings: ['Call'],
    what: 'a base interface it cannot read',
  },
  {
    declarations: 'type Target = OmitThisParameter<((this: Window) => Error) & { label: string }>;',
    readings: ['omitted'],
    what: 'a resolved intersection',
  },
  {
    declarations:
      'interface Call { (this: Window): Error }\ntype Target = OmitThisParameter<Call>;',
    readings: ['omitted'],
    what: 'a resolved interface',
  },
] as const;

describe('an omitted receiver of an uncertain selection', () => {
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
