import {
  type ArrowFunction,
  isArrowFunction,
  isVariableStatement,
  type SourceFile,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { localsOf } from '../src/compiler/answers.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The names a function declares of its own leave out those of the functions and classes within it,
 * the one its body is too: of `(a) => (b) => { const c = a + b; }`, `c` is the inner arrow's.
 */
const CASES = [
  {
    id: 'curried-arrow',
    source: 'const outer = (a: number) => (b: number) => { const c = a + b; return c; };',
    declared: ['a'],
    constants: [],
  },
  {
    id: 'function-expression-body',
    source: 'const outer = () => function inner() { const c = 1; return c; };',
    declared: [],
    constants: [],
  },
  {
    id: 'class-expression-body',
    source: 'const outer = () => class { static { const c = 1; void c; } };',
    declared: [],
    constants: [],
  },
  {
    id: 'block-body-pin',
    source:
      'const outer = (a: number) => { const c = a; const f = () => { const d = 1; return d; }; return c + f(); };',
    declared: ['a', 'c', 'f'],
    constants: ['c', 'f'],
  },
];

/** The arrow the first statement of `file` declares `outer` of, or none. */
function outerArrow(file: SourceFile): ArrowFunction | undefined {
  const [statement] = file.statements;
  const initializer =
    statement !== undefined && isVariableStatement(statement)
      ? statement.declarationList.declarations[0]?.initializer
      : undefined;
  return initializer !== undefined && isArrowFunction(initializer) ? initializer : undefined;
}

/** Names in a fixed order, as the cases list them. */
function sorted(names: Iterable<string>): readonly string[] {
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

describe('the locals of a function whose body is a function', () => {
  it.each(CASES)('$id', ({ source, declared, constants }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'answers-locals.ts', source);
    const outer = outerArrow(parsed.sourceFile);
    const locals = outer === undefined ? undefined : localsOf(outer);

    expect(locals === undefined ? undefined : sorted(locals.declared)).toStrictEqual(declared);
    expect(locals === undefined ? undefined : sorted(locals.constants.keys())).toStrictEqual(
      constants,
    );
  });
});
