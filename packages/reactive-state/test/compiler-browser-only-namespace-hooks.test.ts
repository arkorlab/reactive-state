import {
  isArrowFunction,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  type Node,
} from 'typescript/ast';
import { API, ScriptKind } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserOnlyIn } from '../src/compiler/browser-only.ts';

/**
 * A hook is React's where the file imports it of `react` and no scope around the call gives the name
 * again. A namespace's body is a scope of its own: a function, a constant or a `var` it declares, or
 * a body it merges with exports, hides the import from its reads, so that a function of that name is
 * the namespace's, which may call its callback as the server renders — not an effect of React's,
 * whose callback the browser alone runs. A namespace that declares nothing of the name, another
 * namespace's names, and a type of the name leave the import as it was.
 */

const REACT = "import { useCallback, useEffect } from 'react';";
const REACT_WHOLE = "import * as React from 'react';";

const CASES = [
  {
    lines: [
      REACT,
      'export function Widget() {',
      '  useEffect(() => marker());',
      '  return <p>fixed</p>;',
      '}',
    ],
    skipped: true,
    what: "the module's effect of React's",
  },
  {
    lines: [
      REACT,
      'namespace Helpers {',
      '  export function render() {',
      '    useEffect(() => marker());',
      '    return <p>fixed</p>;',
      '  }',
      '}',
    ],
    skipped: true,
    what: "a namespace's effect of React's",
  },
  {
    lines: [
      REACT,
      'namespace Own {',
      '  export function useEffect(run: () => void) {',
      '    run();',
      '  }',
      '}',
      'namespace Other {',
      '  export function render() {',
      '    useEffect(() => marker());',
      '    return <p>fixed</p>;',
      '  }',
      '}',
    ],
    skipped: true,
    what: "another namespace's own function",
  },
  {
    lines: [
      REACT,
      'namespace Helpers {',
      '  type useEffect = number;',
      '  export function render() {',
      '    useEffect(() => marker());',
      '    return <p>fixed</p>;',
      '  }',
      '}',
    ],
    skipped: true,
    what: "a namespace's type of the name",
  },
  {
    lines: [
      REACT_WHOLE,
      'namespace Helpers {',
      '  export function render() {',
      '    React.useEffect(() => marker());',
      '    return <p>fixed</p>;',
      '  }',
      '}',
    ],
    skipped: true,
    what: "a namespace's effect of React's, by the whole",
  },
  {
    lines: [
      REACT,
      'namespace Helpers {',
      '  export function render(useEffect: (run: () => void) => void) {',
      '    useEffect(() => marker());',
      '    return <p>fixed</p>;',
      '  }',
      '}',
    ],
    skipped: false,
    what: "a parameter of a namespace's function",
  },
  {
    lines: [
      REACT,
      'namespace Helpers {',
      '  function useEffect(run: () => void) {',
      '    run();',
      '  }',
      '  export function render() {',
      '    useEffect(() => marker());',
      '    return <p>fixed</p>;',
      '  }',
      '}',
    ],
    skipped: false,
    what: "a namespace's own function",
  },
  {
    lines: [
      REACT,
      'namespace Helpers {',
      '  const useEffect = (run: () => void) => {',
      '    run();',
      '  };',
      '  export function render() {',
      '    useEffect(() => marker());',
      '    return <p>fixed</p>;',
      '  }',
      '}',
    ],
    skipped: false,
    what: "a namespace's own constant",
  },
  {
    lines: [
      REACT,
      'namespace Helpers {',
      '  if (typeof window === "undefined") {',
      '    var useEffect = (run: () => void) => {',
      '      run();',
      '    };',
      '  }',
      '  export function render() {',
      '    useEffect(() => marker());',
      '    return <p>fixed</p>;',
      '  }',
      '}',
    ],
    skipped: false,
    what: "a var of the namespace's block",
  },
  {
    lines: [
      REACT,
      'namespace Helpers {',
      '  export function useEffect(run: () => void) {',
      '    run();',
      '  }',
      '}',
      'namespace Helpers {',
      '  export function render() {',
      '    useEffect(() => marker());',
      '    return <p>fixed</p>;',
      '  }',
      '}',
    ],
    skipped: false,
    what: "a merged body's export",
  },
  {
    lines: [
      REACT,
      'namespace Outer.Inner {',
      '  function useEffect(run: () => void) {',
      '    run();',
      '  }',
      '  export function render() {',
      '    useEffect(() => marker());',
      '    return <p>fixed</p>;',
      '  }',
      '}',
    ],
    skipped: false,
    what: "a dotted namespace's own function",
  },
  {
    lines: [
      REACT,
      'namespace Outer {',
      '  function useEffect(run: () => void) {',
      '    run();',
      '  }',
      '  export namespace Inner {',
      '    export function render() {',
      '      useEffect(() => marker());',
      '      return <p>fixed</p>;',
      '    }',
      '  }',
      '}',
    ],
    skipped: false,
    what: 'the namespace around a nested one',
  },
  {
    lines: [
      REACT,
      'namespace Other {',
      '  export function run(callback: () => void) {',
      '    callback();',
      '  }',
      '}',
      'namespace Helpers {',
      '  import useEffect = Other.run;',
      '  export function render() {',
      '    useEffect(() => marker());',
      '    return <p>fixed</p>;',
      '  }',
      '}',
    ],
    skipped: false,
    what: "a namespace's alias of another's function",
  },
  {
    lines: [
      REACT_WHOLE,
      'namespace Helpers {',
      '  const React = {',
      '    useEffect(run: () => void) {',
      '      run();',
      '    },',
      '  };',
      '  export function render() {',
      '    React.useEffect(() => marker());',
      '    return <p>fixed</p>;',
      '  }',
      '}',
    ],
    skipped: false,
    what: "a namespace's own object of the name `React`",
  },
  {
    lines: [
      REACT,
      'namespace Helpers {',
      '  export function Button() {',
      '    const handler = useCallback(() => marker());',
      '    return <button onClick={() => handler()}>fixed</button>;',
      '  }',
      '}',
    ],
    skipped: true,
    what: "a namespace's callback of React's",
  },
  {
    lines: [
      REACT,
      'namespace Helpers {',
      '  function useCallback(run: () => void) {',
      '    run();',
      '    return run;',
      '  }',
      '  export function Button() {',
      '    const handler = useCallback(() => marker());',
      '    return <button onClick={() => handler()}>fixed</button>;',
      '  }',
      '}',
    ],
    skipped: false,
    what: "a namespace's own function of a callback",
  },
] as const;

describe('a hook of React in a namespace that declares the name again', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `browserOnlyIn` skips the function `() => marker()` of the Client Component's module `lines`. */
  function skipsMarked(lines: readonly string[]): boolean {
    const source = `'use client';\n${lines.join('\n')}\n`;
    using parsed = api.createSourceFile('widget.tsx', source, { scriptKind: ScriptKind.TSX });
    let marked: Node | undefined;
    const visit = (node: Node): void => {
      if (
        (isArrowFunction(node) || isFunctionExpression(node)) &&
        isCallExpression(node.body) &&
        isIdentifier(node.body.expression) &&
        node.body.expression.text === 'marker'
      ) {
        marked = node;
      }
      node.forEachChild(visit);
    };
    parsed.sourceFile.forEachChild(visit);
    if (marked === undefined) {
      throw new Error('No function `() => marker()` is written.');
    }
    return browserOnlyIn(parsed.sourceFile)(marked);
  }

  it.each(CASES)('$what', ({ lines, skipped }) => {
    expect(skipsMarked(lines)).toBe(skipped);
  });
});
