import {
  isArrowFunction,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import { API, ScriptKind } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserOnlyIn } from '../src/compiler/browser-only.ts';

/**
 * A non-null assertion, `handler!`, hands on what it is written of, as `as` does: a function an
 * effect or an event of an element of the platform's is handed past one is the browser's alone, as
 * it is past parentheses and a cast.
 */

const REACT = "import { useEffect } from 'react';";

const CASES = [
  {
    lines: [REACT, 'export function Widget() {', '  useEffect(() => marker());', '}'],
    skipped: true,
    what: 'an effect',
  },
  {
    lines: [REACT, 'export function Widget() {', '  useEffect((() => marker())!);', '}'],
    skipped: true,
    what: 'a callback of an effect asserted non-null',
  },
  {
    lines: [
      REACT,
      'export function Widget() {',
      '  useEffect(((() => marker()) as () => void)!);',
      '}',
    ],
    skipped: true,
    what: 'a callback of an effect cast, then asserted non-null',
  },
  {
    lines: [
      'export function Widget() {',
      '  return <button onClick={(() => marker())!}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: "an event's function asserted non-null",
  },
  {
    lines: [
      'const handler = () => marker();',
      'export function Widget() {',
      '  return <button onClick={handler!}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: "a function of the module an event's attribute names asserted non-null",
  },
  {
    lines: [
      'const handler = () => marker();',
      'export function Widget() {',
      '  return <p ref={handler!}>fixed</p>;',
      '}',
    ],
    skipped: true,
    what: 'a function of the module a ref names asserted non-null',
  },
  {
    lines: [
      'const handler = () => marker();',
      'export function Widget() {',
      '  return <Button onClick={handler!}>fixed</Button>;',
      '}',
    ],
    skipped: false,
    what: "a function a component's prop names, which the component may call as it renders",
  },
  {
    lines: [
      'const handler = () => marker();',
      'export function Widget() {',
      '  return <p>{handler!()}</p>;',
      '}',
    ],
    skipped: false,
    what: 'a function called as the document renders',
  },
] as const;

/** The function `() => marker()` of a module, which `browserOnlyIn` may skip. */
function markedIn(sourceFile: SourceFile): Node {
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
  sourceFile.forEachChild(visit);
  if (marked === undefined) {
    throw new Error('No function `() => marker()` is written.');
  }
  return marked;
}

describe('what a non-null assertion hands to the browser alone', () => {
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
