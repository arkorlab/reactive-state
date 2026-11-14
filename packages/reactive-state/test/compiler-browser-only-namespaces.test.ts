import {
  isArrowFunction,
  isFunctionDeclaration,
  isIdentifier,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';
import { API, ScriptKind } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserOnlyIn } from '../src/compiler/browser-only.ts';

/**
 * A function a namespace exports is read as the namespace's member, `Helpers.read()`, by no name of
 * its own: the browser alone runs it no more than an export of the module's, whatever its name's
 * reads say. One the namespace keeps to itself is read by its name, as the module's own are.
 */

const CASES = [
  {
    lines: [
      'namespace Helpers {',
      '  export function read() {',
      '    return navigator.language;',
      '  }',
      '}',
      'export function Widget() {',
      '  return <p>{Helpers.read()}</p>;',
      '}',
    ],
    skipped: false,
    what: "a namespace's exported function",
  },
  {
    lines: [
      'namespace Helpers {',
      '  export const read = () => navigator.language;',
      '}',
      'export function Widget() {',
      '  return <p>{Helpers.read()}</p>;',
      '}',
    ],
    skipped: false,
    what: "a namespace's exported constant",
  },
  {
    lines: [
      'namespace Outer.Helpers {',
      '  export function read() {',
      '    return navigator.language;',
      '  }',
      '}',
      'export function Widget() {',
      '  return <p>{Outer.Helpers.read()}</p>;',
      '}',
    ],
    skipped: false,
    what: "a dotted namespace's export",
  },
  {
    lines: [
      'namespace Helpers {',
      '  function read() {',
      '    return navigator.language;',
      '  }',
      '  export const Button = () => <button onClick={() => read()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: "a namespace's own function",
  },
  {
    lines: [
      'function read() {',
      '  return navigator.language;',
      '}',
      'export function Widget() {',
      '  return <button onClick={() => read()}>fixed</button>;',
      '}',
    ],
    skipped: true,
    what: "the module's function of an event",
  },
  {
    lines: [
      'function read() {',
      '  return navigator.language;',
      '}',
      'export function Widget() {',
      '  return <p>{read()}</p>;',
      '}',
    ],
    skipped: false,
    what: "the module's function of a render",
  },
] as const;

describe('a function a namespace exports, of the browser alone or not', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `browserOnlyIn` skips `read`, of the Client Component's module `lines`. */
  function skipsRead(lines: readonly string[]): boolean {
    const source = `'use client';\n${lines.join('\n')}\n`;
    using parsed = api.createSourceFile('widget.tsx', source, { scriptKind: ScriptKind.TSX });
    let read: Node | undefined;
    const visit = (node: Node): void => {
      if (isFunctionDeclaration(node) && node.name?.text === 'read') {
        read = node;
      } else if (
        isVariableDeclaration(node) &&
        isIdentifier(node.name) &&
        node.name.text === 'read' &&
        node.initializer !== undefined &&
        isArrowFunction(node.initializer)
      ) {
        read = node.initializer;
      }
      node.forEachChild(visit);
    };
    parsed.sourceFile.forEachChild(visit);
    if (read === undefined) {
      throw new Error('No function `read` is declared.');
    }
    return browserOnlyIn(parsed.sourceFile)(read);
  }

  it.each(CASES)('$what', ({ lines, skipped }) => {
    expect(skipsRead(lines)).toBe(skipped);
  });
});
