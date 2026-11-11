import { isArrowFunction, isFunctionExpression, type Node, type SourceFile } from 'typescript/ast';
import { API, ScriptKind } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserOnlyIn } from '../src/compiler/browser-only.ts';

/**
 * A function expression's own name is the constant that holds it, in `const handler = function
 * handler() {}`: one name, one value, so the function is one candidate for the browser's alone — as
 * `const handler = () => …` is — where every read of the name stands in the browser's code. A name
 * declared twice anywhere in the module, the function's beside another, keeps it out.
 */

const CASES = [
  {
    lines: [
      'const handler = () => {',
      '  marker();',
      '};',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'an arrow held by a constant',
  },
  {
    lines: [
      'const handler = function handler() {',
      '  marker();',
      '};',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'a function expression of the name of the constant that holds it',
  },
  {
    lines: [
      'const handler = (function handler() {',
      '  marker();',
      '});',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'a function expression of that name, in parentheses',
  },
  {
    lines: [
      'const handler = (function handler() {',
      '  marker();',
      '}) satisfies () => void;',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'a function expression of that name, past `satisfies`',
  },
  {
    lines: [
      'const handler = (function handler() {',
      '  marker();',
      '}) as () => void;',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'a function expression of that name, past a cast',
  },
  {
    lines: [
      'const handler = (function handler() {',
      '  marker();',
      '})!;',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'a function expression of that name, past a non-null assertion',
  },
  {
    lines: [
      'const handler = ((function handler() {',
      '  marker();',
      '}) as () => void) satisfies () => void;',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'a function expression of that name, past a cast and `satisfies` in parentheses',
  },
  {
    lines: [
      'const handler = (function handler() {',
      '  marker();',
      '}) satisfies () => void;',
      'export function Widget() {',
      '  return <p>{handler()}</p>;',
      '}',
    ],
    skipped: false,
    what: 'a function expression of that name past `satisfies`, called as the document renders',
  },
  {
    lines: [
      'const handler = function other() {',
      '  marker();',
      '};',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'a function expression of a name of its own',
  },
  {
    lines: [
      'const handler = function handler() {',
      '  marker();',
      '};',
      'export function Widget() {',
      '  return <p>{handler()}</p>;',
      '}',
    ],
    skipped: false,
    what: 'a function expression of that name, called as the document renders',
  },
  {
    lines: [
      'const handler = function handler() {',
      '  marker();',
      '};',
      'export function Widget(handler: () => void) {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: false,
    what: 'a function expression of that name, and a parameter of the name beside it',
  },
  {
    lines: [
      'const handler = function handler() {',
      '  marker();',
      '};',
      'var handler = 1;',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: false,
    what: 'a function expression of that name, and a declaration of the name again',
  },
] as const;

/** The function that calls `marker()` a module writes. */
function markedIn(sourceFile: SourceFile): Node {
  let marked: Node | undefined;
  const visit = (node: Node): void => {
    if (
      (isArrowFunction(node) || isFunctionExpression(node)) &&
      node.getText(sourceFile).includes('marker()')
    ) {
      marked = node;
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  if (marked === undefined) {
    throw new Error('No function that calls `marker()` is written.');
  }
  return marked;
}

describe('a function expression of the name of the constant that holds it', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('reads $what', ({ lines, skipped }) => {
    const source = `'use client';\n${lines.join('\n')}\n`;
    using parsed = api.createSourceFile('widget.tsx', source, { scriptKind: ScriptKind.TSX });
    const marked = markedIn(parsed.sourceFile);

    expect(browserOnlyIn(parsed.sourceFile)(marked)).toBe(skipped);
  });
});
