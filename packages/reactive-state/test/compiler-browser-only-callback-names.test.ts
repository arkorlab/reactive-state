import { isArrowFunction, isFunctionExpression, type Node, type SourceFile } from 'typescript/ast';
import { API, ScriptKind } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserOnlyIn } from '../src/compiler/browser-only.ts';

/**
 * A function expression's own name is the constant that holds it where `useCallback` is handed the
 * function and the constant holds what it answers: in `const handler = useCallback(function
 * handler() {}, [])` the name within is the same function the constant names, one name, one value,
 * as in `const handler = function handler() {}` — so the function is one candidate for the
 * browser's alone, where every read of the name stands in the browser's code. A call of another
 * function, `memoize(function handler() {})`, or one that answers what the function answers,
 * `useMemo(function handler() {}, [])`, holds another value than the function: its name is a
 * second declaration, and keeps the function out.
 */

const REACT = "import * as React from 'react';\nimport { useCallback, useMemo } from 'react';";

const CASES = [
  {
    lines: [
      'const handler = useCallback(() => {',
      '  marker();',
      '}, []);',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'an arrow `useCallback` is handed',
  },
  {
    lines: [
      'const handler = useCallback(function handler() {',
      '  marker();',
      '}, []);',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'a function expression of the name of the constant, handed to `useCallback`',
  },
  {
    lines: [
      'const handler = React.useCallback(function handler() {',
      '  marker();',
      '}, []);',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'that function, handed to `React.useCallback`',
  },
  {
    lines: [
      'const handler = useCallback((function handler() {',
      '  marker();',
      '}) as () => void, []);',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'that function, in a cast and parentheses past which `useCallback` reads it',
  },
  {
    lines: [
      'const handler = useCallback(function handler() {',
      '  marker();',
      '}, []) as () => void;',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'that function, handed to `useCallback` whose answer a cast wraps',
  },
  {
    lines: [
      'const handler = (useCallback(function handler() {',
      '  marker();',
      '}, []))!;',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'that function, handed to `useCallback` in parentheses past a non-null assertion',
  },
  {
    lines: [
      'const handler = useCallback(function other() {',
      '  marker();',
      '}, []);',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'a function expression of a name of its own, handed to `useCallback`',
  },
  {
    lines: [
      'const handler = useCallback(function handler() {',
      '  marker();',
      '}, []);',
      'export function Widget() {',
      '  return <p>{handler()}</p>;',
      '}',
    ],
    skipped: false,
    what: 'that function, called as the document renders',
  },
  {
    lines: [
      'const handler = useCallback(function handler() {',
      '  marker();',
      '}, []);',
      'var handler = 1;',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: false,
    what: 'that function, and a declaration of the name again',
  },
  {
    lines: [
      'const handler = useCallback(function handler() {',
      '  marker();',
      '}, []);',
      'export function Widget(handler: () => void) {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: false,
    what: 'that function, and a parameter of the name beside it',
  },
  {
    lines: [
      'const handler = useMemo(function handler() {',
      '  marker();',
      '  return () => {};',
      '}, []);',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: false,
    what: 'a function expression of that name, which `useMemo` calls and answers what it answers',
  },
  {
    lines: [
      'const handler = memoize(function handler() {',
      '  marker();',
      '});',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: false,
    what: 'a function expression of that name, handed to a function of the module',
  },
  {
    lines: [
      'const handler = useCallback(wrap(function handler() {',
      '  marker();',
      '}), []);',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: false,
    what: 'a function expression of that name, wrapped before `useCallback` is handed it',
  },
  {
    lines: [
      'const handler = useCallback(() => {',
      '  marker();',
      '}, [function handler() {}]);',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: false,
    what: 'a function expression of that name, among the dependencies of `useCallback`',
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

describe('a function expression of the name of the constant that holds it, past useCallback', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('reads $what', ({ lines, skipped }) => {
    const source = `'use client';\n${REACT}\n${lines.join('\n')}\n`;
    using parsed = api.createSourceFile('widget.tsx', source, { scriptKind: ScriptKind.TSX });
    const marked = markedIn(parsed.sourceFile);

    expect(browserOnlyIn(parsed.sourceFile)(marked)).toBe(skipped);
  });
});
