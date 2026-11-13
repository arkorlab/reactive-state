import { isArrowFunction, isFunctionExpression, type Node, type SourceFile } from 'typescript/ast';
import { API, ScriptKind } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserOnlyIn } from '../src/compiler/browser-only.ts';

/**
 * A default import of `react` is `react` read whole, however it is written: `import React from
 * 'react'` and `import { default as React } from 'react'` name the same value, whose members are
 * React's hooks, `React.useEffect`. An import under the name `default` is not a hook of it: `import
 * { default as useEffect }` calls the module, not the hook. A type-only import is no value.
 */

const CASES = [
  {
    imports: "import React from 'react';",
    lines: [
      'export function Widget() {',
      '  React.useEffect(() => {',
      '    marker();',
      '  }, []);',
      '  return <p>fixed</p>;',
      '}',
    ],
    skipped: true,
    what: 'a default import, read for `React.useEffect`',
  },
  {
    imports: "import { default as React } from 'react';",
    lines: [
      'export function Widget() {',
      '  React.useEffect(() => {',
      '    marker();',
      '  }, []);',
      '  return <p>fixed</p>;',
      '}',
    ],
    skipped: true,
    what: 'a default import written as a name, read for `React.useEffect`',
  },
  {
    imports: "import { 'default' as React } from 'react';",
    lines: [
      'export function Widget() {',
      '  React.useEffect(() => {',
      '    marker();',
      '  }, []);',
      '  return <p>fixed</p>;',
      '}',
    ],
    skipped: true,
    what: 'a default import written as a string, read for `React.useEffect`',
  },
  {
    imports: "import { default as R, useCallback } from 'react';",
    lines: [
      'export function Widget() {',
      '  R.useEffect(() => {',
      '    marker();',
      '  }, []);',
      '  return <p>fixed</p>;',
      '}',
    ],
    skipped: true,
    what: 'a default import beside a named one, under another name',
  },
  {
    imports: "import { default as React } from 'react';",
    lines: [
      'const handler = React.useCallback(() => {',
      '  marker();',
      '}, []);',
      'export function Widget() {',
      '  return <button onClick={() => handler()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: 'a default import written as a name, read for `React.useCallback`',
  },
  {
    imports: "import { default as React } from 'react';",
    lines: [
      'export function Widget() {',
      '  React.useMemo(() => {',
      '    marker();',
      '  }, []);',
      '  return <p>fixed</p>;',
      '}',
    ],
    skipped: false,
    what: 'a default import written as a name, read for a hook that runs as the document renders',
  },
  {
    imports: "import { default as useEffect } from 'react';",
    lines: [
      'export function Widget() {',
      '  useEffect(() => {',
      '    marker();',
      '  }, []);',
      '  return <p>fixed</p>;',
      '}',
    ],
    skipped: false,
    what: 'the default import called, under the name of a hook',
  },
  {
    imports: "import { type default as React } from 'react';",
    lines: [
      'export function Widget() {',
      '  React.useEffect(() => {',
      '    marker();',
      '  }, []);',
      '  return <p>fixed</p>;',
      '}',
    ],
    skipped: false,
    what: 'a default import of a type alone',
  },
  {
    imports: "import type { default as React } from 'react';",
    lines: [
      'export function Widget() {',
      '  React.useEffect(() => {',
      '    marker();',
      '  }, []);',
      '  return <p>fixed</p>;',
      '}',
    ],
    skipped: false,
    what: 'a default import in a list of types alone',
  },
  {
    imports: "import { default as React } from 'preact';",
    lines: [
      'export function Widget() {',
      '  React.useEffect(() => {',
      '    marker();',
      '  }, []);',
      '  return <p>fixed</p>;',
      '}',
    ],
    skipped: false,
    what: "a default import of a module that is not React's",
  },
  {
    imports: "import { default as React } from 'react';",
    lines: [
      'export function Widget(React: { useEffect(run: () => void): void }) {',
      '  React.useEffect(() => {',
      '    marker();',
      '  });',
      '  return <p>fixed</p>;',
      '}',
    ],
    skipped: false,
    what: 'a default import, and a parameter of the name beside it',
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

describe('the name a default import of react is read by', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('reads $what', ({ imports, lines, skipped }) => {
    const source = `'use client';\n${imports}\n${lines.join('\n')}\n`;
    using parsed = api.createSourceFile('widget.tsx', source, { scriptKind: ScriptKind.TSX });
    const marked = markedIn(parsed.sourceFile);

    expect(browserOnlyIn(parsed.sourceFile)(marked)).toBe(skipped);
  });
});
