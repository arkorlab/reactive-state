import {
  isConditionalTypeNode,
  isIdentifier,
  isModuleBlock,
  isModuleDeclaration,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  type Statement,
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
 * A non-const enum an ambient context declares numbers no member it gives no initializer:
 * TypeScript reads `declare enum D { A, B = 0 }`'s `A` as computed, apart from `B`, and
 * `{ k: D.A } & { k: D.B }` as `never`, though counting would give both `0`. An ambient context is
 * a `declare` on the enum or on a namespace around it, and a declaration file. The reader leaves such
 * a member's value unknown. Each row is the matcher's answer for `Source extends { missing: number }`;
 * the const, the declared and the initialized enums pin what the change keeps.
 */
const CASES: readonly {
  readonly declarations: string;
  readonly source: string;
  readonly matches: boolean | undefined;
  readonly what: string;
  /** The file's name, where it is not a source file's. */
  readonly file?: string;
  /** A namespace the whole program is written in. */
  readonly inside?: string;
}[] = [
  {
    declarations: 'declare enum D { A, B = 0 }',
    source: '{ k: D.A } & { k: D.B }',
    matches: undefined,
    what: 'an ambient member counted to a value',
  },
  {
    declarations: 'declare enum D { A = 1, B, C = 2 }',
    source: '{ k: D.B } & { k: D.C }',
    matches: undefined,
    what: 'an ambient member after an initializer',
  },
  {
    declarations: 'enum D { A, B = 0 }',
    inside: 'declare namespace Space',
    source: '{ k: D.A } & { k: D.B }',
    matches: undefined,
    what: 'a member of a declared namespace',
  },
  {
    declarations: 'enum D { A, B = 0 }',
    file: 'ambient.d.ts',
    source: '{ k: D.A } & { k: D.B }',
    matches: undefined,
    what: 'a member of a declaration file',
  },
  {
    declarations: 'export declare enum D { A, B = 0 }',
    source: '{ k: D.A } & { k: D.B }',
    matches: undefined,
    what: 'an exported ambient member',
  },
  {
    declarations: 'declare namespace Space { enum D { A, B = 0 } }',
    source: '{ k: Space.D } & { k: Space.D }',
    matches: undefined,
    what: 'a whole enum stays unknown',
  },
  {
    declarations: 'declare const enum D { A, B = 0 }',
    source: '{ k: D.A } & { k: D.B }',
    matches: false,
    what: 'an ambient const enum counts',
  },
  {
    declarations: 'enum D { A, B = 0 }',
    source: '{ k: D.A } & { k: D.B }',
    matches: false,
    what: 'a declared enum counts',
  },
  {
    declarations: 'enum D { A, B = 0 }',
    inside: 'namespace Space',
    source: '{ k: D.A } & { k: D.B }',
    matches: false,
    what: "a plain namespace's enum counts",
  },
  {
    declarations: "declare enum D { A = 'a', B = 'b' }",
    source: '{ k: D.A } & { k: D.B }',
    matches: true,
    what: 'ambient initializers are values',
  },
];

/** The aliases a statement list declares, those of a namespace's body among them. */
function declaredAliases(statements: readonly Statement[]): Map<string, TypeAliasDeclaration> {
  const aliases = new Map<string, TypeAliasDeclaration>();
  const pending = [...statements];
  for (let statement = pending.pop(); statement !== undefined; statement = pending.pop()) {
    if (isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement);
    else if (
      isModuleDeclaration(statement) &&
      statement.body !== undefined &&
      isModuleBlock(statement.body)
    )
      pending.push(...statement.body.statements);
  }
  return aliases;
}

describe('an ambient enum member of no initializer', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The matcher's answer for `Source extends { missing: number }`, with local aliases followed. */
  function matched(
    declarations: string,
    source: string,
    {
      file = 'enum-fields.ts',
      inside,
    }: { file?: string | undefined; inside?: string | undefined } = {},
  ): boolean | undefined {
    const program = `${declarations}\ntype Source = ${source};\ntype Check = Source extends { missing: number } ? true : false;\n`;
    using parsed = api.createSourceFile(
      file,
      inside === undefined ? program : `${inside} {\n${program}}\n`,
    );
    const aliases = declaredAliases(parsed.sourceFile.statements);
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

  it.each(CASES)('$what', ({ declarations, source, matches, file, inside }) => {
    expect(matched(declarations, source, { file, inside })).toBe(matches);
  });
});
