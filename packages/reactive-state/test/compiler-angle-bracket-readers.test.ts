import {
  type Expression,
  isArrowFunction,
  isCallExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isVariableStatement,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import { API, ScriptKind } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { browserOnlyIn } from '../src/compiler/browser-only.ts';
import { handedGlobal } from '../src/compiler/handed-globals.ts';
import { isIterator } from '../src/compiler/iterators.ts';

/**
 * A cast in angle brackets, `<any>items.values`, hands on what it is written of, as `as` does, in a
 * module of `.ts` — and `unwrapped` leaves it. The readers beside `code-globals.ts` look through it
 * themselves, as it does: what makes an iterator, a key written as text of a global a module hands
 * on, and what a Client Component's `.ts` module calls its hooks by.
 */

const ITERATORS = [
  { iterator: true, source: '(<any>items.values)()', what: 'a method cast' },
  { iterator: true, source: "items[<string>'values']()", what: 'a method by a key cast' },
  { iterator: true, source: '<any>items.values()', what: 'the iterator cast' },
  { iterator: true, source: "(<any>items.values())['map']((x) => x)", what: 'a helper of a cast' },
  {
    iterator: true,
    source: '(<any>Array.prototype[Symbol.iterator]).call(items)',
    what: 'a borrowed method cast',
  },
  {
    iterator: true,
    source: 'Array.prototype[<symbol>Symbol.iterator].call(items)',
    what: 'a borrowed symbol cast',
  },
  { iterator: true, source: '(<any>Iterator).from(items)', what: 'a global of a function cast' },
  { iterator: true, source: '(items.values as any)()', what: 'a method cast with `as`' },
  { iterator: false, source: '(<any>items.map)((x) => x)', what: 'a method that answers an array' },
  {
    iterator: false,
    source: "items[<string>'at'](0)",
    what: 'a key cast of a method of no iterator',
  },
  { iterator: false, source: '(<any>Object).keys(items)', what: 'a global that answers an array' },
] as const;

const HANDED = [
  { hands: false, source: "Math['abs']", what: 'a member by text' },
  { hands: false, source: "Math[<string>'abs']", what: 'a member by a key cast' },
  {
    hands: false,
    source: "Math[<string>('abs' as string)]",
    what: 'a member by a key cast of a cast',
  },
  { hands: true, source: 'Math[<string>key]', what: 'a member by a key the code computes, cast' },
] as const;

const BROWSER = [
  {
    lines: ['export function useStamp() {', '  useEffect(() => marker());', '}'],
    skipped: true,
    what: 'an effect of React',
  },
  {
    lines: ['export function useStamp() {', '  (<any>useEffect)(() => marker());', '}'],
    skipped: true,
    what: 'an effect of React, cast',
  },
  {
    lines: ['export function useStamp() {', '  useEffect(<any>(() => marker()));', '}'],
    skipped: true,
    what: 'the callback of an effect, cast',
  },
  {
    lines: ['export function useStamp() {', '  (<any>React).useEffect(() => marker());', '}'],
    skipped: true,
    what: 'an effect of React imported whole, cast',
  },
  {
    lines: [
      'export function useStamp() {',
      '  const handler = <any>useCallback(() => marker(), []);',
      '  useEffect(() => handler());',
      '}',
    ],
    skipped: true,
    what: "a constant of React's callback, cast, read by the browser alone",
  },
  {
    lines: [
      'export function useStamp(useEffect: (run: () => void) => void) {',
      '  (<any>useEffect)(() => marker());',
      '}',
    ],
    skipped: false,
    what: "a parameter's call, cast",
  },
  {
    lines: [
      'export function useStamp(run: (fn: () => void) => void) {',
      '  (<any>run)(() => marker());',
      '}',
    ],
    skipped: false,
    what: 'a function of the module, cast',
  },
] as const;

/** The initializer of the last constant `sourceFile`, the module `source`, declares: `made`. */
function madeOf(source: string, sourceFile: SourceFile): Expression {
  let found: Expression | undefined;
  sourceFile.forEachChild((statement) => {
    if (isVariableStatement(statement)) {
      found = statement.declarationList.declarations.at(-1)?.initializer;
    }
  });
  if (found === undefined) {
    throw new Error(`No constant is declared in ${source}.`);
  }
  return found;
}

/** What `member`, a member in brackets, is a member of: `Math` of `Math['abs']`. */
function receiverOf(member: Expression): Expression {
  if (!isElementAccessExpression(member)) {
    throw new Error('No member in brackets is written.');
  }
  return member.expression;
}

/** The function `() => marker()` `sourceFile` writes. */
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

describe('a cast in angle brackets, read past by what reads beside the globals', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(ITERATORS)('reads an iterator of $what', ({ iterator, source }) => {
    const text = `const items = [1];\nexport const made = ${source};\n`;
    using parsed = api.createSourceFile('iterators.ts', text);
    const made = madeOf(text, parsed.sourceFile);

    expect(
      isIterator(
        made,
        (node) => unwrapped(node),
        () => false,
      ),
    ).toBe(iterator);
  });

  it.each(HANDED)('reads the global object handed on by $what', ({ hands, source }) => {
    const text = `export const made = ${source};\n`;
    using parsed = api.createSourceFile('handed.ts', text);
    const math = receiverOf(madeOf(text, parsed.sourceFile));

    expect(handedGlobal(math, new Set(['Math.random'])) !== undefined).toBe(hands);
  });

  it.each(BROWSER)('reads the browser alone of $what', ({ lines, skipped }) => {
    const text = [
      "'use client';",
      "import * as React from 'react';",
      "import { useCallback, useEffect } from 'react';",
      ...lines,
      '',
    ].join('\n');
    using parsed = api.createSourceFile('stamp.ts', text, { scriptKind: ScriptKind.TS });
    const marked = markedIn(parsed.sourceFile);

    expect(browserOnlyIn(parsed.sourceFile)(marked)).toBe(skipped);
  });
});
