import {
  isConditionalTypeNode,
  isIdentifier,
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
import { inferPattern } from '../src/compiler/local-type-inference.ts';

/**
 * A call or construct signature an interface, an intersection or a function type supplies is read
 * as a literal's own one is: `Call extends { (): infer R }` infers `R` from the one written
 * signature of its kind, whichever way the callable is written. Each row is TypeScript 7.1's answer:
 * whether `Call` matches, and what `R` is. Several signatures of the kind, whose order and overloads
 * the parts decide, and a shape with none, stay uncertain: those two rows pin what the change keeps.
 */
const CASES = [
  {
    declarations: 'interface Call { (): Error }',
    pattern: '{ (): infer R }',
    matches: true,
    inferred: ['Error'],
    what: "an interface's call signature",
  },
  {
    declarations: 'interface Call { new (): Error }',
    pattern: '{ new (): infer R }',
    matches: true,
    inferred: ['Error'],
    what: "an interface's construct signature",
  },
  {
    declarations: 'interface Base { (): Error } interface Call extends Base {}',
    pattern: '{ (): infer R }',
    matches: true,
    inferred: ['Error'],
    what: 'an inherited call signature',
  },
  {
    declarations: 'interface Call { (): Error; label: string }',
    pattern: '{ (): infer R }',
    matches: true,
    inferred: ['Error'],
    what: 'a call signature beside a field',
  },
  {
    declarations: 'type Call = { (): Error } & { label: string };',
    pattern: '{ (): infer R }',
    matches: true,
    inferred: ['Error'],
    what: "an intersected literal's signature",
  },
  {
    declarations: 'type Call = (() => Error) & { label: string };',
    pattern: '{ (): infer R }',
    matches: true,
    inferred: ['Error'],
    what: 'an intersected function type',
  },
  {
    declarations: 'type Call = (new () => Error) & { label: string };',
    pattern: '{ new (): infer R }',
    matches: true,
    inferred: ['Error'],
    what: 'an intersected constructor type',
  },
  {
    declarations: 'type Call = () => Error;',
    pattern: '{ (): infer R }',
    matches: true,
    inferred: ['Error'],
    what: 'a function type',
  },
  {
    declarations: 'interface Call { (label: string): Error }',
    pattern: '{ (): infer R }',
    matches: false,
    inferred: [],
    what: 'a signature of more required parameters',
  },
  {
    declarations: 'type Call = abstract new () => Error;',
    pattern: '{ new (): infer R }',
    matches: false,
    inferred: [],
    what: 'an abstract constructor type',
  },
  {
    declarations: "interface Call { (): 'first'; (): 'second' }",
    pattern: '{ (): infer R }',
    matches: undefined,
    inferred: [],
    what: 'overloads stay uncertain',
  },
  {
    declarations: 'interface Call { label: string }',
    pattern: '{ (): infer R }',
    matches: undefined,
    inferred: [],
    what: 'no signature stays uncertain',
  },
] as const;

describe('a signature that parts of a callable supply', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The matcher's answer for `Call extends pattern`, and the written types inferred for `R`. */
  function matched(
    declarations: string,
    pattern: string,
  ): { readonly matches: boolean | undefined; readonly inferred: readonly string[] } {
    using parsed = api.createSourceFile(
      'part-signatures.ts',
      `${declarations}\ntype Check = Call extends ${pattern} ? R : never;\n`,
    );
    const aliases = new Map<string, TypeAliasDeclaration>();
    for (const statement of parsed.sourceFile.statements) {
      if (isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement);
    }
    const conditional = aliases.get('Check')?.type;
    if (conditional === undefined || !isConditionalTypeNode(conditional)) {
      throw new Error('No conditional Check is declared.');
    }
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
    const result = inferPattern(
      initialTypeReading(conditional.checkType),
      initialTypeReading(conditional.extendsType),
      resolve,
      // A stand-in relation that knows only a written type's identity with itself.
      (actual, expected) => (actual.type === expected.type ? true : undefined),
    );
    return {
      matches: result.matches,
      inferred: result.alternatives.flatMap((bindings) =>
        [...bindings.values()].map((reading) => reading.type.getText()),
      ),
    };
  }

  it.each(CASES)('$what', ({ declarations, pattern, matches, inferred }) => {
    expect(matched(declarations, pattern)).toStrictEqual({ matches, inferred });
  });
});
