import {
  type CallExpression,
  isCallExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { rootOf } from '../src/compiler/kept.ts';
import { patternSymbolName } from '../src/compiler/pattern-writes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { writtenBy } from '../src/compiler/written.ts';

/** Mutable, assigned and destructured symbol-key aliases preserve sticky-pattern write tracking. */
const CASES = [
  {
    id: 'let-symbol-replace-sticky-pattern',
    source: [
      'let key = Symbol.replace;',
      'const pattern = /a/y;',
      "export function check(text: string) { return pattern[key](text, '-'); }",
    ].join('\n'),
    symbolName: 'Symbol.replace',
    writtenRoot: 'pattern',
  },
  {
    id: 'let-symbol-match-sticky-pattern',
    source: [
      'let key = Symbol.match;',
      'const pattern = /a/y;',
      'export function check(text: string) { return pattern[key](text); }',
    ].join('\n'),
    symbolName: 'Symbol.match',
    writtenRoot: 'pattern',
  },
  {
    id: 'var-symbol-replace-sticky-pattern',
    source: [
      'var key = Symbol.replace;',
      'const pattern = /a/y;',
      "export function check(text: string) { return pattern[key](text, '-'); }",
    ].join('\n'),
    symbolName: 'Symbol.replace',
    writtenRoot: 'pattern',
  },
  {
    id: 'assigned-let-symbol-replace-sticky-pattern',
    source: [
      'const pattern = /a/y;',
      "export function check(text: string) { let key: typeof Symbol.replace; key = Symbol.replace; return pattern[key](text, '-'); }",
    ].join('\n'),
    symbolName: 'Symbol.replace',
    writtenRoot: 'pattern',
  },
  {
    id: 'branched-let-symbol-replace-sticky-pattern',
    source: [
      'const pattern = /a/y;',
      'export function check(text: string, replaceMode: boolean) {',
      '  let key: symbol = Symbol.search;',
      '  if (replaceMode) { key = Symbol.replace; }',
      '  return (pattern as unknown as Record<symbol, (input: string) => unknown>)[key](text);',
      '}',
    ].join('\n'),
    symbolName: 'Symbol.replace',
    writtenRoot: 'pattern',
  },
  {
    id: 'chained-let-symbol-match-alias',
    source: [
      'let base = Symbol.match;',
      'let alias = base;',
      'const pattern = /a/y;',
      'export function check(text: string) { return pattern[alias](text); }',
    ].join('\n'),
    symbolName: 'Symbol.match',
    writtenRoot: 'pattern',
  },
  {
    id: 'destructured-const-symbol-replace-alias',
    source: [
      'const { replace: key } = { replace: Symbol.replace };',
      'const pattern = /a/y;',
      "export function check(text: string) { return pattern[key](text, '-'); }",
    ].join('\n'),
    symbolName: 'Symbol.replace',
    writtenRoot: 'pattern',
  },
  {
    id: 'parameter-default-symbol-replace-alias',
    source: [
      'const pattern = /a/y;',
      "export function check(text: string, key = Symbol.replace) { return pattern[key](text, '-'); }",
    ].join('\n'),
    symbolName: 'Symbol.replace',
    writtenRoot: 'pattern',
  },
  {
    id: 'borrowed-call-through-let-symbol-replace',
    source: [
      'let key = Symbol.replace;',
      'const pattern = /a/y;',
      "export function check(text: string) { return RegExp.prototype[key].call(pattern, text, '-'); }",
    ].join('\n'),
    symbolName: 'Symbol.replace',
    writtenRoot: 'pattern',
  },
  {
    id: 'let-symbol-replace-global-pattern-reset',
    source: [
      'let key = Symbol.replace;',
      'const pattern = /a/g;',
      "export function check(text: string) { return pattern[key](text, '-'); }",
    ].join('\n'),
    symbolName: 'Symbol.replace',
    writtenRoot: undefined,
  },
  {
    id: 'const-symbol-replace-sticky-pattern-pin',
    source: [
      'const key = Symbol.replace;',
      'const pattern = /a/y;',
      "export function check(text: string) { return pattern[key](text, '-'); }",
    ].join('\n'),
    symbolName: 'Symbol.replace',
    writtenRoot: 'pattern',
  },
  {
    id: 'definitely-overwritten-let-symbol-search-pin',
    source: [
      'const pattern = /a/y;',
      'export function check(text: string) {',
      '  let key: symbol = Symbol.replace;',
      '  key = Symbol.search;',
      '  return (pattern as unknown as Record<symbol, (input: string) => unknown>)[key](text);',
      '}',
    ].join('\n'),
    symbolName: undefined,
    writtenRoot: undefined,
  },
  {
    id: 'shadowed-symbol-let-alias-pin',
    source: [
      "const Symbol = { replace: 'custom' } as const;",
      'let key = Symbol.replace;',
      'const holder = { custom(text: string) { return text; } };',
      'export function check(text: string) { return holder[key](text); }',
    ].join('\n'),
    symbolName: undefined,
    writtenRoot: undefined,
  },
  {
    id: 'mutable-let-pattern-receiver-still-stateful-pin',
    source: [
      'let pattern = /a/;',
      'pattern = /a/g;',
      'export function check(text: string) { return pattern.test(text); }',
    ].join('\n'),
    symbolName: undefined,
    writtenRoot: 'pattern',
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

/** The bracket key expression on `call.expression` or `call.expression.expression` (for `.call`). */
function bracketKeyOf(call: CallExpression | undefined): string | undefined {
  if (call === undefined) {
    return undefined;
  }
  const callee = unwrapped(call.expression);
  if (isElementAccessExpression(callee)) {
    return patternSymbolName(callee.argumentExpression);
  }
  if (isPropertyAccessExpression(callee)) {
    const inner = unwrapped(callee.expression);
    if (isElementAccessExpression(inner)) {
      return patternSymbolName(inner.argumentExpression);
    }
  }
  return undefined;
}

describe('symbol-method write tracking across mutable key aliases', () => {
  it.each(CASES)('$id', ({ source, symbolName, writtenRoot }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'pattern-symbol-aliases.ts', source);
    const call = finalCall(parsed.sourceFile);
    const target = call === undefined ? undefined : writtenBy(call);

    expect(bracketKeyOf(call)).toBe(symbolName);
    expect(target === undefined ? undefined : rootOf(target)?.text).toBe(writtenRoot);
  });
});
