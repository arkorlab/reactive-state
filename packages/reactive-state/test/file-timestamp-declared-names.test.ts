import { type Expression, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalPathOf } from '../src/compiler/code-globals.ts';
import { fileReadsClock, hasFileTimestamp } from '../src/compiler/file-timestamps.ts';

/**
 * A name that nothing reads is no use of the constant of a File's options, nor of a constant that
 * holds the File constructor, whatever the name it carries: a declared name of a type, a namespace
 * or an alias, a label of a qualified name in an alias (`Types.options` of `import options =
 * Types.options`, whichever of its parts), a member, a label, a parameter, a type parameter and an
 * export or import specifier. TypeScript emits nothing for these that reads the name around them,
 * so the File keeps the timestamp it was given. The same names beside a read, a write or an escape
 * of the constant are not excused, which the last rows check.
 */

type Wrap = 'namespace' | 'top';

/** What names `NAME` where nothing reads it, and where its statement may stand. */
const POSITIONS: readonly (readonly [string, string, Wrap])[] = [
  ['type alias', 'type NAME = string;', 'namespace'],
  ['interface', 'interface NAME { a: 1 }', 'namespace'],
  ['type-only namespace', 'namespace NAME { export interface J {} }', 'namespace'],
  ['alias name', 'import NAME = Types.T;', 'namespace'],
  ['alias right label', 'import NAME = Types.NAME;', 'namespace'],
  ['alias right label, exported', 'export import NAME = Types.NAME;', 'namespace'],
  ['alias left label', 'import x = Ns.T;', 'namespace'],
  ['alias middle label', 'import x = Types.NAME.T;', 'namespace'],
  ['alias of the namespace', 'import x = Types;', 'namespace'],
  [
    'alias left label, own namespace',
    'namespace NAME { export interface T {} } import x = NAME.T;',
    'namespace',
  ],
  [
    'alias left label, exported',
    'namespace NAME { export interface T {} } export import x = NAME.T;',
    'namespace',
  ],
  ['alias right label of an enum member', 'enum E { NAME = 1 } import x = E.NAME;', 'namespace'],
  [
    'alias right label of a namespace member',
    'namespace M { export const NAME = 1; } import x = M.NAME;',
    'namespace',
  ],
  ['alias through an alias', 'import mid = Types; import x = mid.NAME;', 'namespace'],
  [
    'alias chain labels',
    'namespace A2 { export namespace NAME { export interface T {} } } import x = A2.NAME.T;',
    'namespace',
  ],
  ['enum member name', 'enum E { NAME = 1 }', 'namespace'],
  ['class property name', 'class C { NAME = 1; }', 'namespace'],
  ['class method name', 'class C { NAME() {} }', 'namespace'],
  [
    'class accessors',
    'class C { get NAME() { return 1; } set NAME(v: number) {} static NAME2 = 1; }',
    'namespace',
  ],
  ['declare field', 'class C { declare NAME: number; }', 'namespace'],
  ['abstract method', 'abstract class C { abstract NAME(): void; }', 'namespace'],
  ['object property name', 'const o = { NAME: 1 };', 'namespace'],
  ['object method name', 'const o = { NAME() {} };', 'namespace'],
  ['object accessor name', 'const o = { get NAME() { return 1; } };', 'namespace'],
  ['property access', 'const o = { NAME: 1 }; o.NAME; o?.NAME;', 'namespace'],
  ['label', 'NAME: for (;;) { break NAME; }', 'namespace'],
  ['continue label', 'NAME: for (let i = 0; i < 1; i++) { continue NAME; }', 'namespace'],
  ['block label', 'NAME: { break NAME; }', 'namespace'],
  ['function parameter', 'function f(NAME: number) { return NAME; }', 'namespace'],
  ['overload parameter', 'function f(NAME: number): void; function f(NAME: any) {}', 'namespace'],
  ['arrow parameter', 'const g = (NAME: number) => NAME;', 'namespace'],
  ['method parameter', 'class C { m(NAME: number) { return NAME; } }', 'namespace'],
  ['parameter property', 'class C { constructor(public NAME: number) {} }', 'namespace'],
  ['catch variable', 'try {} catch (NAME) {}', 'namespace'],
  ['for-of variable', 'for (const NAME of []) {}', 'namespace'],
  ['for-in variable', 'for (const NAME in {}) {}', 'namespace'],
  ['function name', 'function NAME() {}', 'namespace'],
  ['class name', 'class NAME {}', 'namespace'],
  ['function expression name', 'const h = function NAME() {};', 'namespace'],
  ['class expression name', 'const k = class NAME {};', 'namespace'],
  ['enum name', 'enum NAME { a }', 'namespace'],
  ['value namespace name', 'namespace NAME { export const x = 1; }', 'namespace'],
  ['variable name', 'const NAME = 1;', 'namespace'],
  ['type parameter', 'function f<NAME>() {}', 'namespace'],
  ['class type parameter', 'class C<NAME> {}', 'namespace'],
  ['type alias type parameter', 'type G<NAME> = NAME[];', 'namespace'],
  ['type literal', 'let v: { NAME: number };', 'namespace'],
  ['type query', 'let w: typeof NAME;', 'namespace'],
  ['type reference', 'interface NAME { a: 1 } let u: NAME;', 'namespace'],
  ['implements', 'interface NAME { a: 1 } class D implements NAME { a: 1 = 1; }', 'namespace'],
  [
    'implements with arguments',
    'interface NAME<T> { a: T } class D2 implements NAME<number> { a = 1; }',
    'namespace',
  ],
  [
    'class extends a value',
    'class Base {} class D3 extends Base {} interface NAME {}',
    'namespace',
  ],
  ['interface extends', 'interface NAME { a: 1 } interface I2 extends NAME {}', 'namespace'],
  ['binding property name', 'const { NAME: y } = { NAME: 1 };', 'namespace'],
  ['named tuple', 'type TT = [NAME: string];', 'namespace'],
  ['index signature', 'type IS = { [NAME: string]: number };', 'namespace'],
  ['type predicate', 'function p(NAME: any): NAME is string { return true; }', 'namespace'],
  ['generic argument', 'function id<T>() {} interface NAME { a: 1 } id<NAME>();', 'namespace'],
  ['satisfies', 'interface NAME { a: 1 } const s = { a: 1 } satisfies NAME;', 'namespace'],
  ['as type', 'interface NAME { a: 1 } const s2 = { a: 1 } as NAME;', 'namespace'],
  ['extends type argument', 'interface NAME { a: 1 } class E2 extends Array<NAME> {}', 'namespace'],
  ['declare function', 'declare function NAME(): void;', 'namespace'],
  ['declare const', 'declare const NAME: number;', 'namespace'],
  ['declare namespace', 'declare namespace NAME { const x: number; }', 'namespace'],
  ['import type alias', "import type { NAME as Z } from 'x';", 'top'],
  ['import specifier', "import { NAME as Z2 } from 'x';", 'top'],
  ['import default', "import NAME from 'x';", 'top'],
  ['import namespace', "import * as NAME from 'x';", 'top'],
  ['export specifier label', 'const y1 = 1; export { y1 as NAME };', 'top'],
  ['export type', "export type { NAME } from 'x';", 'top'],
  ['re-export', "export { NAME } from 'x';", 'top'],
  ['re-export alias', "export { Q as NAME } from 'x';", 'top'],
  ['export namespace', "export * as NAME from 'x';", 'top'],
];

const HOLDER = {
  head: (name: string): string => `const ${name}: { lastModified?: number } = { lastModified: 0 };`,
  name: 'options',
  tail: (name: string): string => `new File([], 'x', ${name});`,
};

const CONSTRUCTOR = {
  head: (name: string): string => `const ${name} = File;`,
  name: 'F',
  tail: (name: string): string => `new ${name}([], 'x', { lastModified: 0 });`,
};

/** The namespaces the rows of an alias name, with the name among their members. */
function types(name: string): string {
  return `namespace Types { export interface T {} export interface ${name} { a: 1 } export namespace ${name} { export interface T {} } } namespace Ns { export interface T {} }`;
}

/** The program of a position, and the form of what it names. */
function program(form: typeof HOLDER, text: string, wrap: Wrap): string {
  const body = text.split('NAME').join(form.name);
  const placed = wrap === 'namespace' ? `namespace N { ${body} }` : body;
  return `${form.head(form.name)} ${types(form.name)} ${placed} ${form.tail(form.name)}`;
}

/** Reads, writes and escapes of the name beside the labels above, which the File cannot ignore. */
const READS = [
  [
    'a write beside an alias of an interface',
    'import NAME = Types.T; NAME.lastModified = undefined;',
  ],
  ['a write beside a qualified label', 'import x = Types.NAME; NAME.lastModified = undefined;'],
  ['an escape into an object', 'import x = Types.NAME; const o = { NAME };'],
  ['an escape into an array', 'import x = Types.NAME; const a = [NAME];'],
  ['an escape into a call', 'import x = Types.NAME; Object.assign(NAME, {});'],
] as const;

/** Whether `expression` reads the global `File`. */
function isGlobalFile(expression: Expression): boolean {
  return globalPathOf(expression)?.join('.') === 'File';
}

describe('a File beside names that nothing reads', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the last File `source` makes shows its timestamp, and whether it reads the clock. */
  function timestampOf(source: string): { readonly dated: boolean; readonly clock: boolean } {
    using parsed = api.createSourceFile('file-timestamp.ts', source);
    let made: NewExpression | undefined;
    const visit = (node: Node): void => {
      if (isNewExpression(node)) {
        made = node;
      }
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (made === undefined) {
      throw new Error(`No File is made in ${source}.`);
    }
    return { clock: fileReadsClock(made, isGlobalFile), dated: hasFileTimestamp(made) };
  }

  it.each(POSITIONS)('options beside %s', (_what, text, wrap) => {
    expect(timestampOf(program(HOLDER, text, wrap))).toStrictEqual({ clock: false, dated: true });
  });

  it.each(POSITIONS)('a constructor alias beside %s', (_what, text, wrap) => {
    expect(timestampOf(program(CONSTRUCTOR, text, wrap))).toStrictEqual({
      clock: false,
      dated: true,
    });
  });

  it.each(READS)('options beside %s', (_what, text) => {
    expect(timestampOf(program(HOLDER, text, 'namespace'))).toStrictEqual({
      clock: true,
      dated: false,
    });
  });
});
