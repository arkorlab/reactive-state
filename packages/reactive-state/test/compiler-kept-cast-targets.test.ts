import {
  type Identifier,
  isBinaryExpression,
  isIdentifier,
  isPrefixUnaryExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isKept, rootOf } from '../src/compiler/kept.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { writtenBy } from '../src/compiler/written.ts';

/** Type assertions around write targets and startup IIFEs preserve kept-binding provenance. */
const CASES = [
  {
    id: 'as-cast-factory-member-assignment',
    source: [
      'function makeStore() {',
      '  let count = 0;',
      '  const store: unknown = {};',
      '  (store as Record<string, () => number>).next = () => ++count;',
      '  return store;',
      '}',
      'export const sharedStore = makeStore();',
    ].join('\n'),
    kept: true,
    expectedRoot: 'store',
  },
  {
    id: 'satisfies-cast-factory-member-assignment',
    source: [
      'function makeStore() {',
      '  let count = 0;',
      '  const store: Record<string, () => number> = {};',
      '  (store satisfies Record<string, () => number>).next = () => ++count;',
      '  return store;',
      '}',
      'export const sharedStore = makeStore();',
    ].join('\n'),
    kept: true,
    expectedRoot: 'store',
  },
  {
    id: 'cast-element-access-factory-assignment',
    source: [
      'function makeStore() {',
      '  let count = 0;',
      '  const store: unknown = {};',
      "  (store as Record<string, () => number>)['next'] = () => ++count;",
      '  return store;',
      '}',
      'export const sharedStore = makeStore();',
    ].join('\n'),
    kept: true,
    expectedRoot: 'store',
  },
  {
    id: 'cast-destructuring-pattern-factory-assignment',
    source: [
      'function makeStore() {',
      '  let count = 0;',
      '  const store: unknown = {};',
      '  ([(store as Record<string, () => number>).next] as [() => number]) = [() => ++count];',
      '  return store;',
      '}',
      'export const sharedStore = makeStore();',
    ].join('\n'),
    kept: true,
    expectedRoot: undefined,
  },
  {
    id: 'as-cast-startup-iife-counter',
    source: [
      'export const next = ((() => {',
      '  let count = 0;',
      '  return () => ++count;',
      '}) as () => () => number)();',
    ].join('\n'),
    kept: true,
    expectedRoot: undefined,
  },
  {
    id: 'satisfies-cast-startup-iife-counter',
    source: [
      'export const next = ((() => {',
      '  let count = 0;',
      '  return () => ++count;',
      '}) satisfies () => () => number)();',
    ].join('\n'),
    kept: true,
    expectedRoot: undefined,
  },
  {
    id: 'plain-factory-member-assignment-pin',
    source: [
      'function makeStore() {',
      '  let count = 0;',
      '  const store: Record<string, () => number> = {};',
      '  store.next = () => ++count;',
      '  return store;',
      '}',
      'export const sharedStore = makeStore();',
    ].join('\n'),
    kept: true,
    expectedRoot: 'store',
  },
  {
    id: 'non-null-factory-member-assignment-pin',
    source: [
      'function makeStore() {',
      '  let count = 0;',
      '  const store: Record<string, () => number> | null = {};',
      '  store!.next = () => ++count;',
      '  return store;',
      '}',
      'export const sharedStore = makeStore();',
    ].join('\n'),
    kept: true,
    expectedRoot: 'store',
  },
  {
    id: 'per-call-cast-factory-not-kept-pin',
    source: [
      'function makeStore() {',
      '  let count = 0;',
      '  const store: unknown = {};',
      '  (store as Record<string, () => number>).next = () => ++count;',
      '  return store;',
      '}',
      'export function run() {',
      '  return makeStore();',
      '}',
    ].join('\n'),
    kept: false,
    expectedRoot: 'store',
  },
];

/** The `count` identifier incremented by `++count` in `file`. */
function incrementedCounter(file: SourceFile): Identifier | undefined {
  let found: Identifier | undefined;
  const visit = (node: Node): void => {
    if (
      found === undefined &&
      isPrefixUnaryExpression(node) &&
      node.operator === SyntaxKind.PlusPlusToken &&
      isIdentifier(node.operand)
    ) {
      found = node.operand;
      return;
    }
    if (found === undefined) {
      node.forEachChild(visit);
    }
  };
  visit(file);
  return found;
}

/** The left-hand side of the first `=` assignment in `file`. */
function firstAssignedTarget(file: SourceFile): Node | undefined {
  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (
      found === undefined &&
      isBinaryExpression(node) &&
      node.operatorToken.kind === SyntaxKind.EqualsToken
    ) {
      found = node.left;
      return;
    }
    if (found === undefined) {
      node.forEachChild(visit);
    }
  };
  visit(file);
  return found;
}

describe('kept bindings across cast write targets and startup calls', () => {
  it.each(CASES)('$id', ({ source, kept, expectedRoot }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'kept-cast-targets.ts', source);
    const counter = incrementedCounter(parsed.sourceFile);
    const assigned = firstAssignedTarget(parsed.sourceFile);

    expect(counter === undefined ? undefined : isKept(counter, writtenBy)).toBe(kept);
    expect(assigned === undefined ? undefined : rootOf(assigned)?.text).toBe(expectedRoot);
  });
});
