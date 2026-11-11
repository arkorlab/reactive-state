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
    source: `namespace M { export namespace N { export const key = 2; } } namespace M { namespace N { ${READ}; } }`,
    what: 'a nested namespace the other body does not export (pin)',
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
  function readOf(source: string): {
    readonly declared: boolean;
    readonly member: string | undefined;
  } {
    using parsed = api.createSourceFile(
      'framed-bindings.ts',
      `declare const value: unknown[]; const key = 1; ${source}`,
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
});
