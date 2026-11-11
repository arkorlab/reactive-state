import {
  type ElementAccessExpression,
  type Identifier,
  isElementAccessExpression,
  isIdentifier,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { frameDeclarationOf, frameMemberName } from '../src/compiler/framed-bindings.ts';

/**
 * What a namespace exports in one of its bodies is a name in each of its others — TypeScript emits
 * `N.key` for a bare `key` there — before a constant around the namespace, wherever the export is
 * written, and whatever it exports: a variable, a function, a class, an enum, a namespace. So the
 * key `value[key]` reads there is none the code fixes, and no declaration is the name's. The rows
 * marked a pin answer the same before the change as after it.
 */

const READ = 'value[key]';

const CASES = [
  { source: `namespace N { export const key = 2; } namespace N { ${READ}; }`, what: 'a const' },
  { source: `namespace N { export let key = 2; } namespace N { ${READ}; }`, what: 'a let' },
  { source: `namespace N { export var key = 2; } namespace N { ${READ}; }`, what: 'a var' },
  {
    source: `namespace N { export function key() { return 2; } } namespace N { ${READ}; }`,
    what: 'a function',
  },
  { source: `namespace N { export class key {} } namespace N { ${READ}; }`, what: 'a class' },
  { source: `namespace N { export enum key { A } } namespace N { ${READ}; }`, what: 'an enum' },
  {
    source: `namespace N { export namespace key { export const own = 1; } } namespace N { ${READ}; }`,
    what: 'a namespace',
  },
  {
    source: `namespace N { export import key = Other.key; } namespace N { ${READ}; }`,
    what: 'an import alias',
  },
  {
    source: `namespace N { export const a = 1, key = 2; } namespace N { ${READ}; }`,
    what: 'one of several constants',
  },
  {
    source: `namespace N { export const { key } = { key: 2 }; } namespace N { ${READ}; }`,
    what: 'a name a pattern exports',
  },
  {
    source: `namespace N { ${READ}; } namespace N { export const key = 2; }`,
    what: 'an export of a later body',
  },
  {
    source: `namespace N { export const key = 2; } namespace N { export const other = 1; } namespace N { ${READ}; }`,
    what: 'an export of the first of three bodies',
  },
  {
    source: `namespace M { export namespace N { export const key = 2; } } namespace M { export namespace N { ${READ}; } }`,
    what: 'an export of a nested namespace’s other body',
  },
  {
    source: `namespace M.N { export const key = 2; } namespace M.N { ${READ}; }`,
    what: 'an export of a dotted namespace’s other body',
  },
  {
    source: `namespace N { export const key = 2; } namespace N { function read() { ${READ}; } }`,
    what: 'a read in a function of the body',
  },
  {
    source: `namespace M.key { export const own = 1; } namespace M { ${READ}; }`,
    what: 'a dotted namespace’s own name',
  },
  {
    source: `namespace A.B.key { export const own = 1; } namespace A.B { ${READ}; }`,
    what: 'a namespace dotted three deep’s own name',
  },
  {
    source: `declare namespace N { const key: number; } namespace N { ${READ}; }`,
    what: 'a member of an ambient namespace, exported with no word',
  },
  {
    source: `declare namespace N { function key(): number; } namespace N { ${READ}; }`,
    what: 'a function of an ambient namespace',
  },
  {
    source: `declare namespace M { namespace N { const key: number; } } namespace M { export namespace N { ${READ}; } }`,
    what: 'a member of an ambient namespace nested in one merged',
  },
  {
    source: `declare namespace M.N { const key: number; } namespace M.N { ${READ}; }`,
    what: 'a member of a dotted ambient namespace',
  },
  {
    source: `namespace N { export namespace key { export const own = 1; } } namespace N { ${READ}; }`,
    what: 'a namespace of a value',
  },
  {
    source: `namespace N { export namespace key { export const enum E { A } } } namespace N { ${READ}; }`,
    what: 'a namespace of a const enum alone',
  },
  {
    source: `namespace N { export namespace key { export import T = Types.T; } } namespace N { ${READ}; }`,
    what: 'a namespace of an exported import alias',
  },
  {
    source: `namespace N { export namespace key { import T = Types.T; export const own = 1; } } namespace N { ${READ}; }`,
    what: 'a namespace of a private import alias beside a value',
  },
  {
    source: `namespace N { export const key = 2; } namespace N { if (kind) { var other = 1; } ${READ}; }`,
    what: 'a var of the body of another name',
  },
  {
    source: `namespace N { export const key = 2; } namespace N { namespace Inner { export var key = 3; } ${READ}; }`,
    what: 'a var a nested namespace exports',
  },
  {
    source: `namespace N { export const key = 2; } namespace N { namespace Inner { if (kind) { var key = 3; } } ${READ}; }`,
    what: 'a var in a block of a nested namespace',
  },
  {
    source: `namespace A { export const key = 2; } namespace A.B { ${READ}; }`,
    what: 'an export of the outer part of a dotted namespace',
  },
  {
    source: `namespace A.B { ${READ}; } namespace A { export const key = 2; }`,
    what: 'an export of a later declaration of the outer part',
  },
  {
    source: `namespace A { export const key = 2; } namespace A.B.C { ${READ}; }`,
    what: 'an export of the outermost of three',
  },
  {
    source: `namespace A.B { export const key = 2; } namespace A.B.C { ${READ}; }`,
    what: 'an export of the middle of three',
  },
  {
    source: `namespace A.key { export const own = 1; } namespace A.B { ${READ}; }`,
    what: 'the name of a dotted namespace beside it',
  },
  {
    source: `declare namespace A { const key: number; } namespace A.B { ${READ}; }`,
    what: 'a member of an ambient outer part',
  },
  {
    source: `declare namespace Z { namespace N { const key: number; } } namespace Z { export namespace N { ${READ}; } }`,
    what: 'a member of an ambient nested namespace an exported one merges with',
  },
  {
    source: `namespace Z { export namespace A { export const key = 2; } } namespace Z { export namespace A.B { ${READ}; } }`,
    what: 'an export of a nested namespace’s outer part',
  },
] as const;

const PINS = [
  {
    source: `namespace N { const key = 2; } namespace N { ${READ}; }`,
    what: 'a name not exported (pin)',
  },
  {
    source: `namespace N { export const key = 2; } namespace O { ${READ}; }`,
    what: 'an export of another namespace (pin)',
  },
  {
    source: `namespace N { export const other = 2; } namespace N { ${READ}; }`,
    what: 'an export of another name (pin)',
  },
  {
    source: `namespace N { export interface key { own: 1 } } namespace N { ${READ}; }`,
    what: 'an interface, which has no value (pin)',
  },
  {
    source: `namespace N { export type key = string; } namespace N { ${READ}; }`,
    what: 'a type alias, which has no value (pin)',
  },
  {
    source: `namespace N { export const key = 2; } ${READ};`,
    what: 'a read beside the namespace (pin)',
  },
  {
    source: `namespace A { const key = 2; } namespace A.B { ${READ}; }`,
    what: 'a private name of the outer part (pin)',
  },
  {
    source: `namespace A.B { export const key = 2; } namespace A.C { ${READ}; }`,
    what: 'an export of a sibling inner part (pin)',
  },
  {
    source: `namespace Z { export const key = 2; } namespace A.B { ${READ}; }`,
    what: 'an export of another namespace beside a dotted one (pin)',
  },
  {
    source: `namespace A { export type key = string; } namespace A.B { ${READ}; }`,
    what: 'a type the outer part exports (pin)',
  },
  {
    source: `namespace M.key { export type T = string; } namespace M { ${READ}; }`,
    what: 'a dotted namespace of types alone (pin)',
  },
  {
    source: `declare namespace N { type key = string; } namespace N { ${READ}; }`,
    what: 'a type of an ambient namespace (pin)',
  },
  {
    source: `namespace N { export namespace key { export type T = string; } } namespace N { ${READ}; }`,
    what: 'a namespace of types alone (pin)',
  },
  {
    source: `namespace N { export namespace key { export namespace inner { export interface I {} } } } namespace N { ${READ}; }`,
    what: 'a namespace of namespaces of types alone (pin)',
  },
  {
    source: `namespace N { export namespace key {} } namespace N { ${READ}; }`,
    what: 'an empty namespace (pin)',
  },
  {
    source: `namespace N { export namespace key { import T = Types.T; } } namespace N { ${READ}; }`,
    what: 'a namespace of a private import alias alone (pin)',
  },
  {
    source: `namespace N { export namespace key { import T = Types.T; export type U = T; } } namespace N { ${READ}; }`,
    what: 'a namespace of a private import alias and a type (pin)',
  },
  {
    source: `namespace N { declare const key: number; } namespace N { ${READ}; }`,
    what: 'a declared const of a body that is not ambient (pin)',
  },
  {
    source: `namespace N { declare function key(): void; } namespace N { ${READ}; }`,
    what: 'a declared function of a body that is not ambient (pin)',
  },
  {
    source: `namespace N { declare class key {} } namespace N { ${READ}; }`,
    what: 'a declared class of a body that is not ambient (pin)',
  },
  {
    source: `declare namespace N { const key: number; export {}; } namespace N { ${READ}; }`,
    what: 'a member of an ambient namespace that exports by `export {}` (pin)',
  },
  {
    source: `namespace Z { export namespace N { export const key = 2; } } namespace Z { namespace N { ${READ}; } }`,
    what: 'a private nested namespace beside an exported one (pin)',
  },
  {
    source: `namespace Z { namespace N { export const key = 2; } } namespace Z { export namespace N { ${READ}; } }`,
    what: 'an exported nested namespace beside a private one (pin)',
  },
  {
    source: `declare namespace Z { namespace N { const key: number; } } namespace Z { namespace N { ${READ}; } }`,
    what: 'a private nested namespace beside an ambient one (pin)',
  },
] as const;

describe('a read of a name another body of a namespace exports', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `value[key]`, the last read of a key in `source`, records, and the declaration of `key`. */
  function readOf(
    source: string,
    outside = 'const key = 1;',
  ): {
    readonly declared: boolean;
    readonly member: string | undefined;
  } {
    using parsed = api.createSourceFile(
      'framed-bindings.ts',
      `declare const value: unknown[]; declare const kind: boolean; ${outside} ${source}`,
    );
    let read: ElementAccessExpression | undefined;
    const find = (node: Node): void => {
      if (isElementAccessExpression(node)) read = node;
      node.forEachChild(find);
    };
    find(parsed.sourceFile);
    if (read === undefined) throw new Error(`No key is read in ${source}.`);
    let name: Identifier | undefined;
    const named = (node: Node): void => {
      if (name === undefined && isIdentifier(node) && node.text === 'key') name = node;
      node.forEachChild(named);
    };
    named(read.argumentExpression);
    if (name === undefined) throw new Error(`No \`key\` is read in ${source}.`);
    return { declared: frameDeclarationOf(name) !== undefined, member: frameMemberName(read) };
  }

  it.each(CASES)('$what', ({ source }) => {
    expect(readOf(source)).toStrictEqual({ declared: false, member: undefined });
  });

  it.each(PINS)('$what', ({ source }) => {
    expect(readOf(source)).toStrictEqual({ declared: true, member: '1' });
  });

  it('reads a var of the body, before what another body exports, as its declaration', () => {
    const source = `namespace N { export const key = 2; } namespace N { if (kind) { var key = 1; } ${READ}; }`;

    // The var is no constant, so no key is told of it, but it is the name's declaration.
    expect(readOf(source)).toStrictEqual({ declared: true, member: undefined });
  });

  it('reads no var of a namespace as one of the file', () => {
    const source = `namespace N { export var key = 3; } ${READ};`;

    // Nothing but the namespace declares it, which a bare name outside it does not reach.
    expect(readOf(source, '')).toStrictEqual({ declared: false, member: undefined });
  });
});
