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
 * Within an enum's initializers a bare name is a member of that enum — of any declaration of it
 * beside them in its scope — before it is a constant around the enum: `enum E { key = 2, entry =
 * value[key] }` reads index `2`, not that of the constant `key`. So the key `value[key]` reads there
 * is none the code fixes, and no declaration is the name's. The rows marked a pin answer the same
 * before the change as after it.
 */

const CASES = [
  {
    source: 'enum E { key = 2, entry = value[key] }',
    what: 'a member before the read',
  },
  {
    source: 'enum E { entry = value[key], key = 2 }',
    what: 'a member after the read',
  },
  {
    source: "enum E { 'key' = 2, entry = value[key] }",
    what: 'a member named by text',
  },
  {
    source: 'const enum E { key = 2, entry = value[key] }',
    what: 'a member of a const enum',
  },
  {
    source: 'enum E { key = 2 } enum E { entry = value[key] }',
    what: 'a member of an enum merged with it',
  },
  {
    source: 'enum E { entry = value[key] } enum E { key = 2 }',
    what: 'a member of an enum merged with it, after',
  },
  {
    source: 'function read() { enum E { key = 2, entry = value[key] } }',
    what: 'a member of an enum of a function’s body',
  },
  {
    source: 'switch (kind) { case 0: enum E { key = 2 } enum E { entry = value[key] } }',
    what: 'a member of a merged enum of a switch’s cases',
  },
  {
    source: 'namespace N { export enum E { key = 2, entry = value[key] } }',
    what: 'a member of an enum of a namespace',
  },
  {
    source: 'enum E { key = 2, entry = value[Number(key)] }',
    what: 'a key computed of a member',
  },
  {
    source:
      'namespace N { export enum E { key = 2 } } namespace N { export enum E { entry = value[key] } }',
    what: 'a member of an enum a namespace’s other body exports',
  },
  {
    source:
      'namespace N { export enum E { entry = value[key] } } namespace N { export enum F { other = 0 } } namespace N { export enum E { key = 2 } }',
    what: 'a member of the exported enum of a third body',
  },
  {
    source:
      'namespace M { export namespace N { export enum E { key = 2 } } } namespace M { export namespace N { export enum E { entry = value[key] } } }',
    what: 'a member of an enum of a namespace nested in a merged one',
  },
  {
    source:
      'namespace M { export namespace N { export enum E { key = 2 } } export namespace N { export enum E { entry = value[key] } } }',
    what: 'a member of an enum of a nested namespace declared again',
  },
  {
    source:
      'declare namespace N { enum E { key = 2 } } namespace N { export enum E { entry = value[key] } }',
    what: 'a member of an ambient enum an exported one merges with',
  },
  {
    source:
      'declare namespace N { export enum E { key = 2 } } declare namespace N { enum E { entry = value[key] } }',
    what: 'a member of an enum of an ambient namespace, exported with no word',
  },
  {
    source:
      'namespace M.N { export enum E { key = 2 } } namespace M.N { export enum E { entry = value[key] } }',
    what: 'a member of an enum of a dotted namespace declared again',
  },
  {
    source:
      'namespace M.N { export enum E { key = 2 } } namespace M { export namespace N { export enum E { entry = value[key] } } }',
    what: 'a member of an enum of a nested namespace a dotted one merges with',
  },
  {
    source:
      'namespace M { export namespace N { export enum E { key = 2 } } } namespace M.N { export enum E { entry = value[key] } }',
    what: 'a member of an enum of a dotted namespace a nested one merges with',
  },
  {
    source:
      'namespace A.B.C { export enum E { key = 2 } } namespace A.B.C { export enum E { entry = value[key] } }',
    what: 'a member of an enum of a namespace dotted three deep',
  },
] as const;

const PINS = [
  { source: 'enum E { other = 2, entry = value[key] }', what: 'a member of another name (pin)' },
  {
    source: 'enum F { key = 2 } enum E { entry = value[key] }',
    what: 'a member of another enum (pin)',
  },
  { source: 'enum E { key = 2 } value[key];', what: 'a read beside the enum (pin)' },
  {
    source: 'namespace N { enum E { key = 2 } } namespace N { enum E { entry = value[key] } }',
    what: 'enums of two bodies that export none (pin)',
  },
  {
    source:
      'namespace N { export enum E { key = 2 } } namespace O { export enum E { entry = value[key] } }',
    what: 'an enum of another namespace (pin)',
  },
  {
    source:
      'namespace N { export enum F { key = 2 } } namespace N { export enum E { entry = value[key] } }',
    what: 'an exported enum of another name (pin)',
  },
  {
    source:
      'namespace N { enum E { key = 2 } } namespace N { export enum E { entry = value[key] } }',
    what: 'an enum of another body that is not exported (pin)',
  },
  {
    source:
      'namespace N { export enum E { key = 2 } } namespace N { enum E { entry = value[key] } }',
    what: 'an enum that is not exported beside one that is (pin)',
  },
  {
    source:
      'declare namespace N { enum E { key = 2 } } namespace N { enum E { entry = value[key] } }',
    what: 'an enum that is not exported beside an ambient one (pin)',
  },
  {
    source:
      'namespace M { export namespace N { export enum E { key = 2 } } } namespace M { namespace N { export enum E { entry = value[key] } } }',
    what: 'a nested namespace one body exports and the other does not (pin)',
  },
  {
    source:
      'namespace M.N { export enum E { key = 2 } } namespace M.O { export enum E { entry = value[key] } }',
    what: 'dotted namespaces of other names (pin)',
  },
  {
    source:
      'namespace M { namespace N { export enum E { key = 2 } } } namespace M { export namespace N { export enum E { entry = value[key] } } }',
    what: 'a nested namespace exported where the other body’s is not (pin)',
  },
  {
    source: 'namespace M.N { enum E { key = 2 } } namespace M.N { enum E { entry = value[key] } }',
    what: 'enums of dotted namespaces that export none (pin)',
  },
  {
    source:
      'namespace M.N { export enum E { key = 2 } } namespace M { namespace N { export enum E { entry = value[key] } } }',
    what: 'a dotted namespace and a nested one that is not exported (pin)',
  },
  {
    source: 'function read(): void { enum E { key = 2 } value[key]; }',
    what: 'a read after the enum in its scope (pin)',
  },
] as const;

describe('a read within an enum that has a member of the name', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /**
   * What `value[…]`, the last read of a key in `source`, records as its member, and whether a
   * declaration is the name `key` it reads.
   */
  function readOf(source: string): {
    readonly declared: boolean;
    readonly member: string | undefined;
  } {
    using parsed = api.createSourceFile(
      'framed-bindings.ts',
      `declare const kind: number; declare const value: unknown[]; const key = 1; ${source}`,
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
