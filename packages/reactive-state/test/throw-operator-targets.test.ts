import { isBinaryExpression, type Node, SyntaxKind } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { membershipThrows } from '../src/compiler/throw-operators.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Row {
  readonly id: string;
  readonly source: string;
}

/** A generator method has an object `prototype`, so `instanceof` reads it and returns `false`. */
const GENERATORS: readonly Row[] = [
  { id: 'a generator method', source: '({}) instanceof (({ *g() {} }).g as any);' },
  { id: 'an async generator method', source: '({}) instanceof (({ async *g() {} }).g as any);' },
  {
    id: 'a generator method held by a constant',
    source: 'const holder = { *g() {} };\n({}) instanceof (holder.g as any);',
  },
];

/** A method that is no generator has no `prototype`: `instanceof` throws, in Node 26.13.1 alike. */
const NO_PROTOTYPE: readonly Row[] = [
  { id: 'an ordinary method', source: '({}) instanceof (({ g() {} }).g as any);' },
  { id: 'an async method', source: '({}) instanceof (({ async g() {} }).g as any);' },
  { id: 'an arrow function', source: '({}) instanceof ((() => {}) as any);' },
];

/** A function written out has a `prototype` object, and `instanceof` returns. */
const PROTOTYPED: readonly Row[] = [
  { id: 'a generator function expression', source: '({}) instanceof (function* () {} as any);' },
  { id: 'a function expression', source: '({}) instanceof (function () {} as any);' },
];

/** The statements before an `instanceof` whose right side is a plain object, in a function body. */
const HOOK =
  'function installHook() { (Object.prototype as any)[Symbol.hasInstance] = () => true; }\n';
const AFTER = 'return ({}) instanceof ({} as any) ? 1 : 2;';
const inBody = (statements: string): string =>
  `${HOOK}function initial() {\n${statements}\n${AFTER}\n}`;

/** A `Math` call whose argument runs application code may install the hook that `instanceof` reads. */
const RUNS_APPLICATION_CODE: readonly Row[] = [
  {
    id: 'void of a call that installs the hook',
    source: inBody('Math.abs(void installHook() as any);'),
  },
  {
    id: 'one argument of two runs the call',
    source: inBody('Math.max(1, void installHook() as any);'),
  },
  {
    id: 'void of a member read, which may run a getter',
    source: inBody('declare const holder: { value: number };\nMath.abs(void holder.value as any);'),
  },
];

/** A `Math` call of written scalars, and a statement that is no `Math` call, as before. */
const UNRELATED_TO_THE_HOOK: readonly Row[] = [
  { id: 'a number', source: inBody('Math.abs(1);') },
  { id: 'two numbers', source: inBody('Math.max(1, 2);') },
  { id: 'a negative number', source: inBody('Math.abs(-1);') },
  { id: 'void of a number', source: inBody('Math.abs(void 0 as any);') },
  {
    id: 'void of the assignment to a local',
    source: inBody('let local = 0;\nMath.abs(void (local = 1) as any);'),
  },
];

/** A call of the hook's installer written as a statement is application work that stays unproven. */
const INSTALLER_STATEMENT: readonly Row[] = [
  { id: 'the installer called as a statement', source: inBody('installHook();') },
];

describe('the Math call before an instanceof', () => {
  it.each(RUNS_APPLICATION_CODE.map((row) => [row.id, row] as const))(
    'leaves an instanceof unproven after %s',
    (_id, row) => {
      expect(throwsOf(row)).toBe(false);
    },
  );

  it.each(UNRELATED_TO_THE_HOOK.map((row) => [row.id, row] as const))(
    'reads a Math call of %s as unrelated to the hook',
    (_id, row) => {
      expect(throwsOf(row)).toBe(true);
    },
  );

  it.each(INSTALLER_STATEMENT.map((row) => [row.id, row] as const))(
    'leaves an instanceof unproven after %s',
    (_id, row) => {
      expect(throwsOf(row)).toBe(false);
    },
  );
});

/** An own hook before an explicit prototype shadows what the prototype holds: `GetMethod` reads it. */
const OWN_HOOK_BEFORE_PROTOTYPE: readonly Row[] = [
  {
    id: 'a number, then a prototype object',
    source: '({}) instanceof ({ [Symbol.hasInstance]: 0, __proto__: {} } as any);',
  },
  {
    id: 'null, then a prototype object',
    source: '({}) instanceof ({ [Symbol.hasInstance]: null, __proto__: {} } as any);',
  },
  {
    id: 'a number, then a prototype that holds a hook',
    source:
      'const base = { [Symbol.hasInstance]: () => true };\n({}) instanceof ({ [Symbol.hasInstance]: 0, __proto__: base } as any);',
  },
];

/** What an explicit prototype leaves unproven, or a hook that is callable or not written whole. */
const OWN_HOOK_UNPROVEN: readonly Row[] = [
  {
    id: 'a function, then a prototype object',
    source: '({}) instanceof ({ [Symbol.hasInstance]: () => true, __proto__: {} } as any);',
  },
  {
    id: 'a method, then a prototype object',
    source: '({}) instanceof ({ [Symbol.hasInstance]() { return true; }, __proto__: {} } as any);',
  },
  { id: 'a prototype object alone', source: '({}) instanceof ({ __proto__: {} } as any);' },
  {
    id: 'a prototype object that holds a hook',
    source:
      'const base = { [Symbol.hasInstance]: () => true };\n({}) instanceof ({ __proto__: base } as any);',
  },
  {
    id: 'a key the code does not write, between',
    source:
      'declare const key: string;\n({}) instanceof ({ [Symbol.hasInstance]: 0, [key]: 1, __proto__: {} } as any);',
  },
  {
    id: 'a spread, between',
    source:
      'declare const extra: object;\n({}) instanceof ({ [Symbol.hasInstance]: 0, ...extra, __proto__: {} } as any);',
  },
];

/** The hook written after the prototype, or alone, or with a null prototype, as before. */
const OWN_HOOK_AS_BEFORE: readonly Row[] = [
  {
    id: 'a prototype object, then a number',
    source: '({}) instanceof ({ __proto__: {}, [Symbol.hasInstance]: 0 } as any);',
  },
  { id: 'a number alone', source: '({}) instanceof ({ [Symbol.hasInstance]: 0 } as any);' },
  { id: 'a plain object', source: '({}) instanceof ({} as any);' },
  { id: 'a null prototype', source: '({}) instanceof ({ __proto__: null } as any);' },
  {
    id: 'a number, then a null prototype',
    source: '({}) instanceof ({ [Symbol.hasInstance]: 0, __proto__: null } as any);',
  },
];

describe('the own hook of an object before its explicit prototype', () => {
  it.each(OWN_HOOK_BEFORE_PROTOTYPE.map((row) => [row.id, row] as const))(
    'reads %s as a throw',
    (_id, row) => {
      expect(throwsOf(row)).toBe(true);
    },
  );

  it.each(OWN_HOOK_UNPROVEN.map((row) => [row.id, row] as const))(
    'leaves %s unproven',
    (_id, row) => {
      expect(throwsOf(row)).toBe(false);
    },
  );

  it.each(OWN_HOOK_AS_BEFORE.map((row) => [row.id, row] as const))(
    'reads %s as a throw',
    (_id, row) => {
      expect(throwsOf(row)).toBe(true);
    },
  );
});

describe('the function target of instanceof', () => {
  it.each(GENERATORS.map((row) => [row.id, row] as const))('reads %s as no throw', (_id, row) => {
    expect(throwsOf(row)).toBe(false);
  });

  it.each(NO_PROTOTYPE.map((row) => [row.id, row] as const))('reads %s as a throw', (_id, row) => {
    expect(throwsOf(row)).toBe(true);
  });

  it.each(PROTOTYPED.map((row) => [row.id, row] as const))('reads %s as no throw', (_id, row) => {
    expect(throwsOf(row)).toBe(false);
  });
});

/** Whether the module answers that the last `instanceof` of the source throws. */
function throwsOf(row: Row): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'operator-targets.ts', row.source);
  const found = lastInstanceof(parsed.sourceFile);
  if (found === undefined) {
    throw new Error('The fixture holds an instanceof.');
  }
  return membershipThrows(found, undefined);
}

/** The last `instanceof` expression of a source, in order of appearance. */
function lastInstanceof(node: Node): Node | undefined {
  let found: Node | undefined;
  const visit = (each: Node): void => {
    found =
      isBinaryExpression(each) && each.operatorToken.kind === SyntaxKind.InstanceOfKeyword
        ? each
        : found;
    each.forEachChild(visit);
  };
  visit(node);
  return found;
}
