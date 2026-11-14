import { isFunctionDeclaration, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { namesLocalMemberType } from '../src/compiler/local-type-reading.ts';

/**
 * A conditional type whose checked type extends `never` keeps both of its branches unless the
 * written syntax says that type is never or is not. A primitive, a literal and a written object
 * shape are not never, and a branch only they could select is dropped; an indexed access, a query,
 * a mapped type, a reference to a type this file cannot read, an unresolved conditional and a
 * `keyof` of a parameter no argument fills may each be never, and `false` for them dropped the
 * branch that holds the error. Each row is whether `Error`, written in the branch the row names, is
 * named by `value`.
 */
const ERRORS = new Set(['Error']);

const CONDITIONALS: readonly {
  readonly id: string;
  readonly declarations: string;
  readonly names: boolean;
}[] = [
  {
    id: 'an indexed access of never',
    declarations: "type R = { value: never }['value'] extends never ? Error : string;",
    names: true,
  },
  {
    id: 'a template of an indexed access of never',
    declarations: `type R = \`\${{ value: never }['value']}\` extends never ? Error : string;`,
    names: true,
  },
  {
    id: 'a template of an indexed access beside a literal',
    declarations: `type R = \`\${{ value: never }['value'] | 'x'}\` extends never ? Error : string;`,
    names: false,
  },
  {
    id: 'an indexed access of an argument that is never',
    declarations:
      "type R<T extends { v: unknown }> = T['v'] extends never ? Error : string; type A = R<{ v: never }>;",
    names: true,
  },
  {
    id: 'an indexed access of a parameter no argument fills',
    declarations:
      "type R<T extends { v: unknown }> = T['v'] extends never ? Error : string; type A<U extends { v: unknown }> = R<U>;",
    names: true,
  },
  {
    id: 'a query of a constant that is never',
    declarations: 'declare const x: never; type R = typeof x extends never ? Error : string;',
    names: true,
  },
  {
    id: 'a mapped type over an argument that is never',
    declarations:
      'type M<T> = { [K in keyof T]: 1 }; type R = M<never> extends never ? Error : string;',
    names: true,
  },
  {
    id: 'a template of a type this file cannot read',
    declarations: `import type { Foo } from './foo'; type R = \`\${Foo}\` extends never ? Error : string;`,
    names: true,
  },
  {
    id: 'a type of another file',
    declarations: "type R = import('./foo').Foo extends never ? Error : string;",
    names: true,
  },
  {
    id: 'a template of a native utility of never',
    declarations: `type R = \`\${Awaited<never>}\` extends never ? Error : string;`,
    names: true,
  },
  {
    id: 'alternatives one of which cannot be read',
    declarations:
      "import type { Foo } from './foo'; type R = (Foo | never) extends never ? Error : string;",
    names: true,
  },
  {
    id: 'keyof a parameter no argument fills',
    declarations: 'type R<T> = keyof T extends never ? Error : string; type A<T> = R<T>;',
    names: true,
  },
  {
    id: 'an unresolved conditional of never branches',
    declarations:
      'type R<T> = (T extends string ? never : never) extends never ? Error : string; type A<T> = R<T>;',
    names: true,
  },
  {
    id: 'an indexed access, the error in the false branch',
    declarations: "type R = { value: never }['value'] extends never ? string : Error;",
    names: true,
  },
  {
    id: 'a query, the error in the false branch',
    declarations: 'declare const x: string; type R = typeof x extends never ? string : Error;',
    names: true,
  },
  {
    id: 'never itself',
    declarations: 'type R = never extends never ? Error : string;',
    names: true,
  },
  {
    id: 'a template of never',
    declarations: `type R = \`\${never}\` extends never ? Error : string;`,
    names: true,
  },
  {
    id: 'keyof an empty object',
    declarations: 'type R = keyof {} extends never ? Error : string;',
    names: true,
  },
  {
    id: 'alternatives that are all never',
    declarations: 'type R = (never | never) extends never ? Error : string;',
    names: true,
  },
  {
    id: 'a primitive',
    declarations: 'type R = string extends never ? Error : string;',
    names: false,
  },
  {
    id: 'unknown',
    declarations: 'type R = unknown extends never ? Error : string;',
    names: false,
  },
  {
    id: 'null',
    declarations: 'type R = null extends never ? Error : string;',
    names: false,
  },
  {
    id: 'a literal',
    declarations: "type R = 'a' extends never ? Error : string;",
    names: false,
  },
  {
    id: 'a written object',
    declarations: 'type R = { a: 1 } extends never ? Error : string;',
    names: false,
  },
  {
    id: 'a tuple',
    declarations: 'type R = [1] extends never ? Error : string;',
    names: false,
  },
  {
    id: 'a function',
    declarations: 'type R = (() => void) extends never ? Error : string;',
    names: false,
  },
  {
    id: 'a readonly array',
    declarations: 'type R = readonly string[] extends never ? Error : string;',
    names: false,
  },
  {
    id: 'an object',
    declarations: 'type R = object extends never ? Error : string;',
    names: false,
  },
  {
    id: 'a class instance',
    declarations: 'class C { x = 1 } type R = C extends never ? Error : string;',
    names: false,
  },
  {
    id: 'alternatives of primitives',
    declarations: 'type R = (string | number) extends never ? Error : string;',
    names: false,
  },
  {
    id: 'a template of a primitive',
    declarations: `type R = \`a\${string}\` extends never ? Error : string;`,
    names: false,
  },
  {
    id: 'a template of literal alternatives',
    declarations: `type R = \`\${1 | 2}\` extends never ? Error : string;`,
    names: false,
  },
  {
    id: 'keyof an object with a key',
    declarations: 'type R = keyof { a: 1 } extends never ? Error : string;',
    names: false,
  },
  {
    id: 'an argument that is a primitive',
    declarations: 'type R<T> = T extends never ? Error : string; type A = R<string>;',
    names: false,
  },
  {
    id: 'a written object, the error in the false branch',
    declarations: 'type R = { a: 1 } extends never ? string : Error;',
    names: true,
  },
];

describe('a conditional type that extends never', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the type `A`, or `R` where no `A` is declared, written as the parameter of a function names an error. */
  function names(declarations: string): boolean {
    const alias = /type A\b/u.test(declarations) ? 'A' : 'R';
    using parsed = api.createSourceFile(
      'never.ts',
      `${declarations} function frames(value: ${alias}) {}\n`,
    );
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error(`No parameter is declared in ${declarations}.`);
    return namesLocalMemberType(written, [], ERRORS);
  }

  it.each(CONDITIONALS)('reads $id', ({ declarations, names: expected }) => {
    expect(names(declarations)).toBe(expected);
  });
});
