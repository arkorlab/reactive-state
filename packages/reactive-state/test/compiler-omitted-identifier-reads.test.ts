import { isFunctionDeclaration, isVariableStatement, type VariableStatement } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canOmit } from '../src/compiler/omitted-work.ts';

/**
 * Leaving a constant's initialization out of the browser skips what evaluating it does, so only a
 * value whose evaluation runs nothing of the application's may be left out. A name is not one: reading
 * it runs a global's getter (`g` of `Object.defineProperty(globalThis, 'g', { get() { … } })`), throws
 * a `ReferenceError` for a `let`, a `const` or a class read before its declaration or for a name
 * nothing declares (Node 26.13 ran each in a function), and the compile does not tell which a name
 * is bound to. Each row is the first statement of a function's body, the rest of the body written
 * after it, and whether `canOmit` takes it as work to leave out.
 */
const REFUSED: readonly { readonly body: string; readonly id: string }[] = [
  { body: 'const unused = g;', id: 'global-accessor' },
  { body: 'const unused = later; const later = 1;', id: 'const-read-before-declaration' },
  { body: 'let unused = later; let later = 1;', id: 'let-read-before-declaration' },
  { body: 'const unused = later; class later {}', id: 'class-read-before-declaration' },
  { body: 'const unused = nothingDeclaresThis;', id: 'undeclared-name' },
  { body: 'const unused = source;', id: 'parameter' },
  { body: 'let unused = source;', id: 'let-parameter' },
  { body: 'const unused = undefined;', id: 'undefined' },
  { body: 'const unused = (g);', id: 'parenthesised' },
  { body: 'const unused = g as unknown;', id: 'cast' },
  { body: 'const unused = g!;', id: 'non-null' },
  { body: 'const unused = g satisfies unknown;', id: 'satisfies' },
  { body: 'const unused = ((g as unknown)!);', id: 'wrapped-twice' },
  { body: 'const unused = [g];', id: 'array-element' },
  { body: 'const unused = [1, [g]];', id: 'nested-array-element' },
  { body: 'const unused = [1, 2, g];', id: 'array-element-after-literals' },
  { body: 'const unused = { value: g };', id: 'property-value' },
  { body: 'const unused = { first: 1, second: { third: g } };', id: 'nested-property-value' },
  { body: 'const unused = { items: [g] };', id: 'array-in-property' },
  { body: 'const unused = [{ value: g }];', id: 'property-in-array' },
  { body: 'const unused = { value: g as unknown };', id: 'cast-property-value' },
  { body: 'const kept = 1, unused = g;', id: 'second-declaration' },
  { body: 'const unused = g, kept = 1;', id: 'first-declaration' },
  { body: 'const { unused } = { unused: 1 };', id: 'pattern-name' },
  { body: 'const unused = { g };', id: 'shorthand-property' },
  { body: 'const unused = { ...source };', id: 'spread-property' },
  { body: 'const unused = [...source];', id: 'spread-element' },
  { body: 'const unused = { [key]: 1 };', id: 'computed-key' },
  { body: 'const unused = source.value;', id: 'member-read' },
  { body: 'const unused = make();', id: 'call' },
  { body: `const unused = \`\${source}\`;`, id: 'template-substitution' },
  { body: 'const unused = typeof g;', id: 'typeof' },
];

const OMITTED: readonly { readonly body: string; readonly id: string }[] = [
  { body: 'const unused = 1;', id: 'number' },
  { body: 'const unused = 1n;', id: 'bigint' },
  { body: "const unused = 'text';", id: 'string' },
  { body: 'const unused = `text`;', id: 'template-without-substitution' },
  { body: 'const unused = true;', id: 'true' },
  { body: 'const unused = false;', id: 'false' },
  { body: 'const unused = null;', id: 'null' },
  { body: 'let unused = 1;', id: 'let-number' },
  { body: 'const unused = (1 as number);', id: 'cast-literal' },
  { body: 'const unused = [1, 2, 3];', id: 'array-of-literals' },
  { body: 'const unused = [1, , 3];', id: 'array-with-a-hole' },
  { body: 'const unused = [[1], [2]];', id: 'nested-arrays' },
  { body: 'const unused = { first: 1, second: "two" };', id: 'object-of-literals' },
  { body: 'const unused = { first: { second: [1] } };', id: 'nested-object' },
  { body: 'const unused = {};', id: 'empty-object' },
  { body: 'const unused = [];', id: 'empty-array' },
  { body: 'const unused = () => g;', id: 'arrow-reading-a-name' },
  { body: 'const unused = function () { return g; };', id: 'function-reading-a-name' },
  { body: 'const unused = [() => g, 1];', id: 'array-of-an-arrow' },
  { body: 'const unused = { run: () => g };', id: 'object-of-an-arrow' },
  { body: 'const first = 1, second = [2];', id: 'several-declarations' },
];

describe('a constant whose initialization reads a name', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `canOmit` leaves out the first statement of the body of a function written with `body`. */
  function omitted(body: string): boolean {
    using parsed = api.createSourceFile(
      'omitted-identifier-reads.ts',
      `function frames(source: any, key: string, make: () => unknown) {\n${body}\n}\n`,
    );
    let first: VariableStatement | undefined;
    for (const declaration of parsed.sourceFile.statements) {
      const [head] =
        (isFunctionDeclaration(declaration) ? declaration.body : undefined)?.statements ?? [];
      if (head !== undefined && isVariableStatement(head)) first = head;
    }
    if (first === undefined) throw new Error(`No variable statement is written in ${body}.`);
    return canOmit(first);
  }

  it.each(REFUSED)('is kept: $id', ({ body }) => {
    expect(omitted(body)).toBe(false);
  });

  it.each(OMITTED)('is left out where it reads none: $id', ({ body }) => {
    expect(omitted(body)).toBe(true);
  });
});
