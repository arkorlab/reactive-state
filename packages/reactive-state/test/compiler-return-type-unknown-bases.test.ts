import { isFunctionDeclaration, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { namesLocalMemberType } from '../src/compiler/local-type-reading.ts';

/**
 * `ReturnType` infers from the last call signature of what it is given, as TypeScript lists them: an
 * interface's own, then each of its bases' in turn, and an intersection's members' in order, as
 * `Parameters`, `ThisParameterType` and `InstanceType` read them. A signature the reader reads after a
 * base it reads as nothing, an import's, is still the last: an interface after it in an intersection,
 * or a base after it. Where none follows that base, the written signatures outside interfaces keep the
 * reading they give. A last signature that writes no result is the last as well, and no earlier one
 * stands for it. Each row is whether `Error` is what the utility names; the rows marked a pin answer
 * the same before the change as after it.
 */

const OPAQUE = 'type Base = import("./external.js").Base;\ntype Data = { stack: string };';

const CASES = [
  {
    id: 'own-signature-before-an-unread-base',
    names: false,
    prelude: `${OPAQUE}\ninterface Maker extends Base { (): Error }`,
    type: 'ReturnType<Maker>',
  },
  {
    id: 'own-signature-before-an-unread-base-among-merged-declarations',
    names: false,
    prelude: `${OPAQUE}\ninterface Maker extends Base { (): Data }\ninterface Maker { (): Error }`,
    type: 'ReturnType<Maker>',
  },
  {
    id: 'own-signature-before-an-unread-base-of-a-generic-interface',
    names: false,
    prelude: `${OPAQUE}\ninterface Maker<T> extends Base { (): T }`,
    type: 'ReturnType<Maker<Error>>',
  },
  {
    id: 'written-signature-after-an-unread-interface-pin',
    names: true,
    prelude: `${OPAQUE}\ninterface Maker extends Base { (): Data }`,
    type: 'ReturnType<Maker & { (): Error }>',
  },
  {
    id: 'written-signature-before-an-unread-interface',
    names: true,
    prelude: `${OPAQUE}\ninterface Maker extends Base { (): Data }`,
    type: 'ReturnType<{ (): Error } & Maker>',
  },
  {
    id: 'read-interface-before-an-unread-interface-pin',
    names: false,
    prelude: `${OPAQUE}\ninterface Maker extends Base { (): Data }\ninterface Known { (): Error }`,
    type: 'ReturnType<Known & Maker>',
  },
  {
    id: 'read-interface-after-an-unread-interface-pin',
    names: true,
    prelude: `${OPAQUE}\ninterface Maker extends Base { (): Data }\ninterface Known { (): Error }`,
    type: 'ReturnType<Maker & Known>',
  },
  {
    id: 'read-base-after-an-unread-base-pin',
    names: true,
    prelude: `${OPAQUE}\ninterface Known { (): Error }\ninterface Maker extends Base, Known {}`,
    type: 'ReturnType<Maker>',
  },
  {
    id: 'read-base-before-an-unread-base',
    names: false,
    prelude: `${OPAQUE}\ninterface Known { (): Error }\ninterface Maker extends Known, Base {}`,
    type: 'ReturnType<Maker>',
  },
  {
    id: 'inherited-signature-after-an-own-one-pin',
    names: false,
    prelude: `${OPAQUE}\ninterface Known { (): Data }\ninterface Maker extends Known { (): Error }`,
    type: 'ReturnType<Maker>',
  },
  {
    id: 'own-signature-of-an-interface-with-no-base-pin',
    names: true,
    prelude: `${OPAQUE}\ninterface Maker { (): Error }`,
    type: 'ReturnType<Maker>',
  },
  {
    id: 'own-signature-before-a-base-whose-base-is-unread',
    names: false,
    prelude: `${OPAQUE}\ninterface Mid extends Base {}\ninterface Maker extends Mid { (): Error }`,
    type: 'ReturnType<Maker>',
  },
  // A last signature that writes no result is the last, as it is for `Parameters` and the rest.
  {
    id: 'last-signature-without-a-result-after-one-with',
    names: false,
    prelude: 'interface Maker { (): Error; (value: string) }',
    type: 'ReturnType<Maker>',
  },
  {
    id: 'last-signature-without-a-result-in-a-written-shape',
    names: false,
    prelude: '',
    type: 'ReturnType<{ (): Error; (value: string) }>',
  },
  {
    id: 'last-signature-with-a-result-after-one-without-pin',
    names: true,
    prelude: 'interface Maker { (value: string); (): Error }',
    type: 'ReturnType<Maker>',
  },
  // The other utilities read the one shape the same way: what the reader cannot read last is the last.
  {
    id: 'parameters-of-an-own-signature-before-an-unread-base-pin',
    names: false,
    prelude: `${OPAQUE}\ninterface Maker extends Base { (value: Error): void }`,
    type: 'Parameters<Maker>',
  },
  {
    id: 'this-parameter-of-an-own-signature-before-an-unread-base-pin',
    names: false,
    prelude: `${OPAQUE}\ninterface Maker extends Base { (this: Error): void }`,
    type: 'ThisParameterType<Maker>',
  },
  {
    id: 'instance-of-an-own-construct-signature-before-an-unread-base-pin',
    names: false,
    prelude: `${OPAQUE}\ninterface Maker extends Base { new (): Error }`,
    type: 'InstanceType<Maker>',
  },
] as const;

describe('the result of an interface whose bases are read as nothing', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the utility `type`, a parameter's type, names `Error` (its first position, for `Parameters`). */
  function namesResult(prelude: string, type: string): boolean {
    using parsed = api.createSourceFile(
      'unknown-bases.ts',
      `${prelude}\nfunction frames(value: ${type}) { return value; }\n`,
    );
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error(`No parameter is declared of ${type}.`);
    return namesLocalMemberType(
      written,
      type.startsWith('Parameters') ? ['0'] : [],
      new Set(['Error']),
    );
  }

  it.each(CASES)('$id', ({ names, prelude, type }) => {
    expect(namesResult(prelude, type)).toBe(names);
  });
});
