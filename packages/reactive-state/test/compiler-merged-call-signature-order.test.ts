import { isFunctionDeclaration, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { namesLocalMemberType } from '../src/compiler/local-type-reading.ts';

/**
 * `ReturnType` of a type of several call signatures reads the last of them, which for an interface
 * of merged declarations is the last signature of the last declaration, as TypeScript 7.1 reads
 * it, and for an interface that extends another the base's last. The later-first order of merged
 * overload sets is that of a call's resolution, which a type's result does not follow. Each row is
 * whether `Error` is the result; all of them pin what the reader already did.
 */
const CASES = [
  {
    declarations:
      'interface I { (a: string): Error } interface I { (a: number): { stack: string } }',
    names: false,
    what: 'a last declaration of data',
  },
  {
    declarations:
      'interface I { (a: string): { stack: string } } interface I { (a: number): Error }',
    names: true,
    what: 'a last declaration of an error',
  },
  {
    declarations:
      'interface I { (a: string): Error; (a: boolean): { stack: string } } interface I { (a: number): { stack: string }; (a: bigint): Error }',
    names: true,
    what: 'several signatures each, the last an error',
  },
  {
    declarations:
      'interface I { (a: string): { stack: string }; (a: boolean): Error } interface I { (a: number): Error; (a: bigint): { stack: string } }',
    names: false,
    what: 'several signatures each, the last data',
  },
  {
    declarations:
      'interface I { (a: string): { stack: string } } interface I { (a: number): Error } interface I { (a: boolean): Error }',
    names: true,
    what: 'three declarations, the last an error',
  },
  {
    declarations:
      'interface I { (a: number): Error } interface I { (a: string): Error } interface I { (a: boolean): { stack: string } }',
    names: false,
    what: 'three declarations, the last data',
  },
  {
    declarations:
      'interface B { (a: string): Error } interface I extends B { (a: number): { stack: string } }',
    names: true,
    what: 'a base after the own signatures, an error',
  },
  {
    declarations:
      'interface B { (a: string): { stack: string } } interface I extends B { (a: number): Error }',
    names: false,
    what: 'a base after the own signatures, data',
  },
] as const;

describe("the last call signature of an interface's merged declarations", () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the `ReturnType` of `I`, a parameter's type, names `Error`. */
  function namesResult(declarations: string): boolean {
    using parsed = api.createSourceFile(
      'merged-signatures.ts',
      `${declarations}\nfunction frames(value: ReturnType<I>) { return value; }\n`,
    );
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error('No parameter is declared of ReturnType<I>.');
    return namesLocalMemberType(written, [], new Set(['Error']));
  }

  it.each(CASES)('$what', ({ declarations, names }) => {
    expect(namesResult(declarations)).toBe(names);
  });
});
