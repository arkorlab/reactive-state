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

/** The colon-form `__proto__` of a literal sets its prototype, so the member it names is absent. */
const PROTOTYPE_KEY: readonly Row[] = [
  {
    id: 'the key __proto__ over a null prototype',
    pattern: '{ __proto__: { x } = {} }',
    argument: '{ __proto__: null }',
  },
  {
    id: 'the string key "__proto__" over a null prototype',
    pattern: '{ "__proto__": { x } = {} }',
    argument: '{ __proto__: null }',
  },
  {
    id: 'the key __proto__, no default, over a null prototype',
    pattern: '{ __proto__: { x } }',
    argument: '{ __proto__: null }',
  },
];

/** The key `__proto__` over what writes no prototype entry, and other keys, as before. */
const OTHER_KEYS_READ: readonly Row[] = [
  {
    id: 'the key __proto__ over an empty object',
    pattern: '{ __proto__: { x } = {} }',
    argument: '{}',
  },
  {
    id: 'the key __proto__ over an object prototype',
    pattern: '{ __proto__: { x } = {} }',
    argument: '{ __proto__: {} }',
  },
  { id: 'the key __proto__ over an array', pattern: '{ __proto__: { x } = {} }', argument: '[0]' },
  {
    id: 'a key over an undefined member',
    pattern: '{ a: { x } = {} }',
    argument: '{ a: undefined }',
  },
  { id: 'a key over an empty object', pattern: '{ a: { x } = {} }', argument: '{}' },
];

/** A key over a null member is read, and the pattern fails on it. */
const NULL_MEMBER: readonly Row[] = [
  { id: 'a key over a null member', pattern: '{ a: { x } = {} }', argument: '{ a: null }' },
];

describe('the __proto__ key of an object pattern', () => {
  it.each(PROTOTYPE_KEY.map((row) => [row.id, row] as const))('leaves %s unproven', (_id, row) => {
    expect(throwsOf(row)).toBe(false);
  });

  it.each(OTHER_KEYS_READ.map((row) => [row.id, row] as const))(
    'reads %s without a failure',
    (_id, row) => {
      expect(throwsOf(row)).toBe(false);
    },
  );

  it.each(NULL_MEMBER.map((row) => [row.id, row] as const))(
    'reads %s and fails on it',
    (_id, row) => {
      expect(throwsOf(row)).toBe(true);
    },
  );
});

/** An array pattern steps the iterator of an object, whose numbered members it never reads. */
const ITERATED_OBJECT: readonly Row[] = [
  {
    id: 'a nested pattern over an iterator and a null member 0',
    pattern: '[[x]]',
    argument: '{ *[Symbol.iterator]() { yield []; }, 0: null }',
  },
  {
    id: 'two nested patterns over an iterator and a null member 1',
    pattern: '[[x], [y]]',
    argument: '{ *[Symbol.iterator]() { yield []; yield []; }, 1: null }',
  },
  {
    id: 'a nested pattern over a constant object',
    pattern: '[[x]]',
    argument: 'source',
    before: 'const source = { *[Symbol.iterator]() { yield []; }, 0: null };\n',
  },
];

/** What an array pattern fails on, or reads without failing, as before. */
const ITERATED_AS_BEFORE: readonly Row[] = [
  {
    id: 'a nested pattern over an iterator alone',
    pattern: '[[x]]',
    argument: '{ *[Symbol.iterator]() { yield []; } }',
  },
  {
    id: 'a pattern over an iterator and a number member 0',
    pattern: '[x]',
    argument: '{ *[Symbol.iterator]() { yield 1; }, 0: 5 }',
  },
  { id: 'a nested pattern over an array', pattern: '[[x]]', argument: '[[1]]' },
  {
    id: 'an object pattern over an iterator and an array member 0',
    pattern: '{ 0: [x] }',
    argument: '{ *[Symbol.iterator]() { yield 1; }, 0: [1] }',
  },
];

const ITERATED_FAILURES: readonly Row[] = [
  { id: 'an object with no iterator', pattern: '[[x]]', argument: '{ 0: [1] }' },
  { id: 'a null element of an array', pattern: '[[x]]', argument: '[null]' },
  { id: 'a null second element of an array', pattern: '[[x], [y]]', argument: '[[1], null]' },
  { id: 'an empty array', pattern: '[[x]]', argument: '[]' },
  { id: 'an object pattern over a null member 0', pattern: '{ 0: [x] }', argument: '{ 0: null }' },
];

describe('an array pattern written over an object', () => {
  it.each(ITERATED_OBJECT.map((row) => [row.id, row] as const))(
    'does not read the numbered members for %s',
    (_id, row) => {
      expect(throwsOf(row)).toBe(false);
    },
  );

  it.each(ITERATED_AS_BEFORE.map((row) => [row.id, row] as const))(
    'reads %s without a failure',
    (_id, row) => {
      expect(throwsOf(row)).toBe(false);
    },
  );

  it.each(ITERATED_FAILURES.map((row) => [row.id, row] as const))(
    'still fails on %s',
    (_id, row) => {
      expect(throwsOf(row)).toBe(true);
    },
  );
});

interface Called {
  readonly id: string;
  /** The parameters of `f`; `a` is the one an element default may write. */
  readonly parameters: string;
  /** The arguments of the call. */
  readonly argument: string;
  readonly before?: string;
}

const iterated = (yielded: string, members = ''): string =>
  `{ *[Symbol.iterator]() { yield ${yielded}; }${members} }`;

/**
 * A default that the value selecting it leaves unknown may run: it may write `a`, so the parameter
 * after it reads `a` as unknown, not as the `null` it was given. Node runs each of these calls
 * (and throws only where the default does not run, which stays unproven).
 */
const MAY_WRITE_A: readonly Called[] = [
  {
    id: 'an array pattern over an iterator that yields undefined',
    parameters: 'a: any, [b = (a = {})]: any, { x }: any = a',
    argument: `null, ${iterated('undefined', ', 0: undefined')}`,
  },
  {
    id: 'an array pattern over an iterator that yields a value',
    parameters: 'a: any, [b = (a = {})]: any, { x }: any = a',
    argument: `null, ${iterated('1', ', 0: undefined')}`,
  },
  {
    id: 'an array pattern over an argument the code does not write',
    parameters: 'a: any, [b = (a = {})]: any, { x }: any = a',
    argument: 'null, items',
    before: 'declare const items: any;\n',
  },
  {
    id: 'a nested array pattern over an iterator',
    parameters: 'a: any, [[c = (a = {})]]: any, { x }: any = a',
    argument: `null, ${iterated('[]', ', 0: null')}`,
  },
  {
    id: 'a default that writes in a function it calls at once',
    parameters: 'a: any, [b = (() => { a = {}; })()]: any, { x }: any = a',
    argument: `null, ${iterated('undefined', ', 0: undefined')}`,
  },
  {
    id: 'a default that writes under an if',
    parameters: 'a: any, [b = (() => { if (a) { a = {}; } })()]: any, { x }: any = a',
    argument: `null, ${iterated('undefined', ', 0: undefined')}`,
  },
];

/** What a default does not write, a known element, and a parameter that is given keep their answer. */
const WRITES_AS_BEFORE: readonly Called[] = [
  {
    id: 'a known array element that is undefined (the default runs)',
    parameters: 'a: any, [b = (a = {})]: any, { x }: any = a',
    argument: 'null, [undefined]',
  },
  {
    id: 'a known empty array (the default runs)',
    parameters: 'a: any, [b = (a = {})]: any, { x }: any = a',
    argument: 'null, []',
  },
  {
    id: 'a third parameter that is given',
    parameters: 'a: any, [b = (a = {})]: any, { x }: any = a',
    argument: `null, ${iterated('undefined', ', 0: undefined')}, {}`,
  },
];

const WRITES_STILL_FAIL: readonly Called[] = [
  {
    id: 'a known array element that is a value (the default does not run)',
    parameters: 'a: any, [b = (a = {})]: any, { x }: any = a',
    argument: 'null, [1]',
  },
  {
    id: 'a default with no write, over an iterator',
    parameters: 'a: any, [b = 1]: any, { x }: any = a',
    argument: `null, ${iterated('undefined', ', 0: undefined')}`,
  },
  {
    id: 'a default with no write, over an argument the code does not write',
    parameters: 'a: any, [b = 1]: any, { x }: any = a',
    argument: 'null, items',
    before: 'declare const items: any;\n',
  },
  {
    id: 'a default that only creates a function that would write',
    parameters: 'a: any, [b = () => { a = {}; }]: any, { x }: any = a',
    argument: `null, ${iterated('undefined', ', 0: undefined')}`,
  },
  {
    id: 'a rest element, whose default there is none',
    parameters: 'a: any, [...rest]: any, { x }: any = a',
    argument: `null, ${iterated('undefined')}`,
  },
];

describe('a default the value that selects it leaves unknown', () => {
  it.each(MAY_WRITE_A.map((row) => [row.id, row] as const))(
    'forgets what it may write for %s',
    (_id, row) => {
      expect(throwsOfCall(row)).toBe(false);
    },
  );

  it.each(WRITES_AS_BEFORE.map((row) => [row.id, row] as const))(
    'reads %s without a failure',
    (_id, row) => {
      expect(throwsOfCall(row)).toBe(false);
    },
  );

  it.each(WRITES_STILL_FAIL.map((row) => [row.id, row] as const))(
    'still fails on %s',
    (_id, row) => {
      expect(throwsOfCall(row)).toBe(true);
    },
  );
});

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
  return throwsOfSource(
    `${row.before ?? ''}function f(${row.pattern}: any) { return 1; }\nf(${row.argument});`,
  );
}

/** Whether the module answers that the call of `f` of a row fails to bind a parameter. */
function throwsOfCall(row: Called): boolean {
  return throwsOfSource(
    `${row.before ?? ''}function f(${row.parameters}) { return 1; }\nf(${row.argument});`,
  );
}

/** Whether the module answers that the last call of `f` in the source fails to bind a parameter. */
function throwsOfSource(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'parameter-selections.ts', source);
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
