import { isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { invocationInitializationThrows } from '../src/compiler/throw-parameters.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Row {
  readonly id: string;
  /** The binding pattern of the one parameter of `f`. */
  readonly pattern: string;
  /** The argument `f` is called with. */
  readonly argument: string;
  /** Statements before the function. */
  readonly before?: string;
}

/** A property that is no index of an array is absent from it, and its default is used. */
const NOT_AN_INDEX: readonly Row[] = [
  { id: 'the key "01"', pattern: '{ "01": { x } = {} }', argument: '[0, null]' },
  { id: 'the empty key', pattern: '{ "": { x } = {} }', argument: '[null]' },
  { id: 'the key "1.0"', pattern: '{ "1.0": { x } = {} }', argument: '[0, null]' },
  { id: 'the key " 1"', pattern: '{ " 1": { x } = {} }', argument: '[0, null]' },
];

/** The index itself reads the element, which is `null` and is destructured. */
const AN_INDEX: readonly Row[] = [
  { id: 'the key "1" over a null element', pattern: '{ "1": { x } = {} }', argument: '[0, null]' },
  { id: 'the key 1 over a null element', pattern: '{ 1: { x } = {} }', argument: '[0, null]' },
];

/** The index over an element that is absent, undefined or an object, as before. */
const AN_INDEX_WITHOUT_FAILURE: readonly Row[] = [
  { id: 'the key "1" over undefined', pattern: '{ "1": { x } = {} }', argument: '[0, undefined]' },
  { id: 'the key "1" over an object', pattern: '{ "1": { x } = {} }', argument: '[0, {}]' },
  { id: 'the key "5" past the end', pattern: '{ "5": { x } = {} }', argument: '[0]' },
  { id: 'the key length', pattern: '{ length: { x } = {} }', argument: '[0]' },
];

describe('the member of an array a pattern selects', () => {
  it.each(NOT_AN_INDEX.map((row) => [row.id, row] as const))(
    'falls back to the default for %s',
    (_id, row) => {
      expect(throwsOf(row)).toBe(false);
    },
  );

  it.each(AN_INDEX.map((row) => [row.id, row] as const))('reads the element for %s', (_id, row) => {
    expect(throwsOf(row)).toBe(true);
  });

  it.each(AN_INDEX_WITHOUT_FAILURE.map((row) => [row.id, row] as const))(
    'reads %s without a failure',
    (_id, row) => {
      expect(throwsOf(row)).toBe(false);
    },
  );
});

/** Whether the module answers that the last call of `f` fails to bind its parameter. */
function throwsOf(row: Row): boolean {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'parameter-selections.ts',
    `${row.before ?? ''}function f(${row.pattern}: any) { return 1; }\nf(${row.argument});`,
  );
  const found = lastCall(parsed.sourceFile);
  if (found === undefined) {
    throw new Error('The fixture calls f.');
  }
  return invocationInitializationThrows(found, undefined, () => false);
}

/** The last call expression of a source. */
function lastCall(node: Node): Node | undefined {
  let found: Node | undefined;
  const visit = (each: Node): void => {
    found = isCallExpression(each) ? each : found;
    each.forEachChild(visit);
  };
  visit(node);
  return found;
}
