import {
  type FunctionTypeNode,
  isFunctionTypeNode,
  isIndexedAccessTypeNode,
  isTypeAliasDeclaration,
  type Node,
  type TypeNode,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { indexedMemberTypes, preservedUtilityType } from '../src/compiler/local-type-members.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

describe('error frames retained by utility types and indexed members', () => {
  it.each([
    'type Wrapped<T> = T extends Error ? { stack: string } : Error; function read(error: Wrapped<Partial<Error>>) { return error.stack; }',
    'type Wrapped<T> = T extends Error ? { stack: string } : Error; function read(error: Wrapped<Readonly<Partial<Error>>>) { return error.stack; }',
    'type Wrapped = [{ error: Error }][0]["error"]; function read(error: Wrapped) { return error.stack; }',
    'type Box<T> = T extends unknown ? { error: T } : never; type Wrapped = Box<Error>["error"]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = { error: Error }[{ key: "error" }["key"]]; function read(error: Wrapped) { return error.stack; }',
    'function read(error: Readonly<Error>) { return error.stack; }',
    'function read(error: Partial<Error>) { return error.stack; }',
    'function read(error: Required<Error>) { return error.stack; }',
    'function read(error: NonNullable<Error | undefined>) { return error.stack; }',
    'type Wrapped<T> = Readonly<Partial<T>>; function read(error: Wrapped<TypeError>) { return error.stack; }',
    'type Wrapped = { error: Error; data: { stack: string } }["error"]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = { error?: Error }["error"]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = { ["error"]: Error }["error"]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = { 1: Error }[1]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = { error: Error; data: { stack: string } }["error" | "data"]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped<T, K extends keyof T> = T[K]; function read(error: Wrapped<{ error: Error }, "error">) { return error.stack; }',
    'type Wrapped = [Error, { stack: string }][0]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = [{ stack: string }, Error][1]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = (readonly [Error, { stack: string }])[0]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = [failure: Error, data: { stack: string }][0]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = [failure?: Error][0]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = Error[][number]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = (readonly Error[])[0]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = [Error, { stack: string }][number]; function read(error: Wrapped) { return error.stack; }',
  ])('refuses the selected engine frames: %s', (source) => {
    expect(framesIn(source)).toStrictEqual([expect.stringContaining('reads `stack` of an error')]);
  });

  it.each([
    'type Wrapped = [{ error: Error; data: { stack: string } }][0]["data"]; function read(error: Wrapped) { return error.stack; }',
    'type Box<T> = T extends unknown ? { error: Error; data: T } : never; type Wrapped = Box<{ stack: string }>["data"]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = { error: Error; data: { stack: string } }[{ key: "data" }["key"]]; function read(error: Wrapped) { return error.stack; }',
    'type Readonly<T> = { stack: string; wrapped?: T }; function read(error: Readonly<Error>) { return error.stack; }',
    'import type { Readonly } from "./application-types"; function read(error: Readonly<Error>) { return error.stack; }',
    'function read(error: Readonly<{ stack: string; error: Error }>) { return error.stack; }',
    'function read(error: Partial<{ stack: string; error: Error }>) { return error.stack; }',
    'function read(error: Required<{ stack?: string; error?: Error }>) { return error.stack; }',
    'function read(error: Record<"error", Error> & { stack: string }) { return error.stack; }',
    'function read(error: Array<Error> & { stack: string }) { return error.stack; }',
    'function read(error: Promise<Error> & { stack: string }) { return error.stack; }',
    'function read(error: Pick<Error, "message"> & { stack: string }) { return error.stack; }',
    'function read(error: Omit<Error, "stack"> & { stack: string }) { return error.stack; }',
    'type Wrapped = { error: Error; data: { stack: string } }["data"]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = [Error, { stack: string }][1]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = [error: Error, data: { stack: string }]["1"]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = (readonly [Error, { stack: string }])[1]; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = { stack: string; error: Error }; function read(error: Wrapped) { return error.stack; }',
    'type Wrapped = { stack: string; error: Error }[][number]; function read(error: Wrapped) { return error.stack; }',
  ])('keeps application fields and utility shadows opaque: %s', (source) => {
    expect(framesIn(source)).toStrictEqual([]);
  });
});

describe('written type member selection', () => {
  it('retains a selected method as a callable value', () => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'selected-method.ts',
      'type Value = { error(): Error }["error"];',
    );
    const member = selectedMethod(parsed.sourceFile);

    expect(member.parameters).toHaveLength(0);
    expect(member.type?.getText()).toBe('Error');
  });

  it.each([
    ['{ error: Error; data: string }["error"]', ['Error']],
    ['{ error: Error; data: string }["data"]', ['string']],
    ['{ error: Error; data: string }["missing"]', []],
    ['{ error: Error; data: string }["error" | "data"]', ['Error', 'string']],
    ['{ ["error"]: Error }["error"]', ['Error']],
    // A computed name the compile cannot read may be "error", so its member stays possible.
    ['{ [KEY]: Error }["error"]', ['Error']],
    ['{ 0x1: Error }[1.0]', ['Error']],
    ['{ get error(): Error }["error"]', ['Error']],
    ['{ set error(value: Error) }["error"]', ['Error']],
    ['[Error, string][0]', ['Error']],
    ['[Error, string]["1"]', ['string']],
    ['[Error, string][number]', ['Error', 'string']],
    ['[failure: Error, data: string][0]', ['Error']],
    ['[failure?: Error][0]', ['Error']],
    ['[Error?][0]', ['Error']],
    ['(readonly [Error, string])[0]', ['Error']],
    ['Error[][number]', ['Error']],
    ['(readonly Error[])[0]', ['Error']],
    ['[Error, string][3]', []],
    ['[Error, string]["01"]', []],
  ] as const)('reads only the selected property or element of %s', (source, expected) => {
    expect(selectedTexts(source)).toStrictEqual(expected);
  });

  it.each([
    '{ error: Error }[string]',
    '{ error: Error }[unknown]',
    '[Error, ...string[]][1]',
    '[...Error[], string][0]',
    'Error[]["length"]',
    'Array<Error>[number]',
  ])('leaves unresolved shapes and indices opaque: %s', (source) => {
    expect(selectedTexts(source)).toBeUndefined();
  });

  it.each(['Readonly', 'Partial', 'Required', 'NonNullable'])(
    'preserves the sole argument of %s',
    (name) => {
      using api = openTypeScript();
      using parsed = parseModule(api, 'utility-argument.ts', 'type Value = Error;');
      const value = aliasType(parsed.sourceFile);

      expect(preservedUtilityType(name, [value])).toBe(value);
      expect(preservedUtilityType(name, undefined)).toBeUndefined();
      expect(preservedUtilityType(name, [value, value])).toBeUndefined();
    },
  );

  it.each(['Record', 'Array', 'ReadonlyArray', 'Promise', 'Pick', 'Omit'])(
    'keeps %s arguments opaque to a whole-value read',
    (name) => {
      using api = openTypeScript();
      using parsed = parseModule(api, 'opaque-utility.ts', 'type Value = Error;');

      expect(preservedUtilityType(name, [aliasType(parsed.sourceFile)])).toBeUndefined();
    },
  );
});

/** A single selected method retains a function node instead of its return as a value. */
function selectedMethod(root: Node): FunctionTypeNode {
  const type = aliasType(root);
  if (!isIndexedAccessTypeNode(type)) throw new Error('The test source is an indexed type.');
  const members = indexedMemberTypes(type.objectType, type.indexType);
  const member = members?.[0];
  if (member === undefined || members?.length !== 1 || !isFunctionTypeNode(member))
    throw new Error('Exactly one selected member retains its callable shape.');
  return member;
}

/** The source texts of the explicit members a written indexed type selects. */
function selectedTexts(source: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'selected-member.ts', `type Value = ${source};`);
  const type = aliasType(parsed.sourceFile);
  if (!isIndexedAccessTypeNode(type)) throw new Error('The test source is an indexed type.');
  return indexedMemberTypes(type.objectType, type.indexType)?.map((member) => member.getText());
}

/** The first alias's body, which each helper's test declares as its input. */
function aliasType(root: Node): TypeNode {
  let type: TypeNode | undefined;
  root.forEachChild((child) => {
    if (isTypeAliasDeclaration(child)) type = child.type;
  });
  if (type === undefined) throw new Error('The test source declares a type alias.');
  return type;
}

/** The frame reads of a module, without unrelated restrictions on its globals. */
function framesIn(source: string): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'error-members.ts', source);
  const found: string[] = [];
  const pending: Node[] = [parsed.sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const reason = framedRead(at);
    if (reason !== undefined) found.push(reason);
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found;
}
