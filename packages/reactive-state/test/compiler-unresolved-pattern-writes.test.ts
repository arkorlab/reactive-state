import {
  type CallExpression,
  isCallExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { rootOf } from '../src/compiler/kept.ts';
import { isStickyPattern, keepsPatternIndex } from '../src/compiler/pattern-writes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { writtenBy } from '../src/compiler/written.ts';

/** Unresolved or mutable pattern receivers preserve stateful lastIndex write tracking. */
const CASES = [
  {
    id: 'member-property-pattern-test',
    source: [
      'const cache = { pattern: /a/g };',
      'export function check(text: string) { return cache.pattern.test(text); }',
    ].join('\n'),
    mode: 'index' as const,
    stateful: true,
    writtenRoot: 'cache',
  },
  {
    id: 'array-element-pattern-exec',
    source: [
      'const patterns = [/a/g];',
      'export function check(text: string) { return patterns[0].exec(text); }',
    ].join('\n'),
    mode: 'index' as const,
    stateful: true,
    writtenRoot: 'patterns',
  },
  {
    id: 'destructured-const-pattern-test',
    source: [
      'const { pattern } = { pattern: /a/g };',
      'export function check(text: string) { return pattern.test(text); }',
    ].join('\n'),
    mode: 'index' as const,
    stateful: true,
    writtenRoot: 'pattern',
  },
  {
    id: 'mutable-let-reassigned-pattern-test',
    source: [
      'let pattern = /a/;',
      'pattern = /a/g;',
      'export function check(text: string) { return pattern.test(text); }',
    ].join('\n'),
    mode: 'index' as const,
    stateful: true,
    writtenRoot: 'pattern',
  },
  {
    id: 'factory-returned-pattern-test',
    source: [
      'function makePattern(): RegExp { return /a/g; }',
      'const pattern = makePattern();',
      'export function check(text: string) { return pattern.test(text); }',
    ].join('\n'),
    mode: 'index' as const,
    stateful: true,
    writtenRoot: 'pattern',
  },
  {
    id: 'aliased-regexp-constructor-global-test',
    source: [
      'const Pattern = RegExp;',
      "const pattern = new Pattern('a', 'g');",
      'export function check(text: string) { return pattern.test(text); }',
    ].join('\n'),
    mode: 'index' as const,
    stateful: true,
    writtenRoot: 'pattern',
  },
  {
    id: 'member-pattern-string-match',
    source: [
      'const cache = { pattern: /a/y };',
      'export function check(text: string) { return text.match(cache.pattern); }',
    ].join('\n'),
    mode: 'sticky-arg' as const,
    stateful: true,
    writtenRoot: 'cache',
  },
  {
    id: 'member-pattern-symbol-replace',
    source: [
      'const cache = { pattern: /a/y };',
      "export function check(text: string) { return cache.pattern[Symbol.replace](text, '-'); }",
    ].join('\n'),
    mode: 'sticky-receiver' as const,
    stateful: true,
    writtenRoot: 'cache',
  },
  {
    id: 'plain-const-literal-test-pin',
    source: [
      'const word = /a/;',
      'export function check(text: string) { return word.test(text); }',
    ].join('\n'),
    mode: 'index' as const,
    stateful: false,
    writtenRoot: undefined,
  },
  {
    id: 'aliased-regexp-constructor-plain-pin',
    source: [
      'const Pattern = RegExp;',
      "const plain = new Pattern('a');",
      'export function check(text: string) { return plain.test(text); }',
    ].join('\n'),
    mode: 'index' as const,
    stateful: false,
    writtenRoot: undefined,
  },
  {
    id: 'object-literal-own-test-method-pin',
    source: [
      'const checker = { test(value: string) { return value.length > 0; } };',
      'export function check(text: string) { return checker.test(text); }',
    ].join('\n'),
    mode: 'index' as const,
    stateful: false,
    writtenRoot: undefined,
  },
  {
    id: 'local-class-own-test-method-pin',
    source: [
      'class Checker { test(value: string) { return value.length > 0; } }',
      'const checker = new Checker();',
      'export function check(text: string) { return checker.test(text); }',
    ].join('\n'),
    mode: 'index' as const,
    stateful: false,
    writtenRoot: undefined,
  },
  {
    id: 'string-typed-parameter-replace-pin',
    source:
      "export function check(text: string, needle: string) { return text.replace(needle, ''); }",
    mode: 'sticky-arg' as const,
    stateful: false,
    writtenRoot: undefined,
  },
  {
    id: 'non-regexp-builtin-date-replace-pin',
    source: "export function check() { return 'epoch'.replace(new Date(0) as never, 'x'); }",
    mode: 'sticky-arg' as const,
    stateful: false,
    writtenRoot: undefined,
  },
];

/** The final call expression in `file` (inside `check`). */
function finalCall(file: SourceFile): CallExpression | undefined {
  let found: CallExpression | undefined;
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      found = node;
    }
    node.forEachChild(visit);
  };
  visit(file);
  return found;
}

/** Evaluates the pattern statefulness helper selected by `mode` against `call`. */
function evaluatePatternFlag(
  call: CallExpression | undefined,
  mode: 'index' | 'sticky-arg' | 'sticky-receiver',
): boolean | undefined {
  if (call === undefined) {
    return undefined;
  }
  const callee = call.expression;
  const receiver =
    isPropertyAccessExpression(callee) || isElementAccessExpression(callee)
      ? callee.expression
      : undefined;
  if (mode === 'index') {
    return receiver === undefined ? undefined : keepsPatternIndex(receiver);
  }
  if (mode === 'sticky-receiver') {
    return receiver === undefined ? undefined : isStickyPattern(receiver);
  }
  const firstArg = call.arguments[0];
  return firstArg === undefined ? undefined : isStickyPattern(firstArg);
}

describe('unresolved and mutable pattern receivers in pattern-writes', () => {
  it.each(CASES)('$id', ({ source, mode, stateful, writtenRoot }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'unresolved-pattern-writes.ts', source);
    const call = finalCall(parsed.sourceFile);
    const flagResult = evaluatePatternFlag(call, mode);
    const target = call === undefined ? undefined : writtenBy(call);

    expect(flagResult).toBe(stateful);
    expect(target === undefined ? undefined : rootOf(target)?.text).toBe(writtenRoot);
  });
});
