import {
  type Expression,
  type Identifier,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isFunctionDeclaration,
  isIdentifier,
  isLiteralTypeNode,
  isNewExpression,
  isParameterDeclaration,
  isParenthesizedTypeNode,
  isRegularExpressionLiteral,
  isUnionTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { BUILT_INS, PLATFORM_ALIKE } from './built-ins.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { constantValue } from './numbers.ts';

/** What matching a retained regular expression changes of its lastIndex. */

/** The symbol methods that, without g, execute a sticky pattern against its current index. */
const INDEXING_SYMBOLS: ReadonlySet<string> = new Set(['Symbol.match', 'Symbol.replace']);
const PRIMITIVE_CALLS: ReadonlySet<string> = new Set([
  'BigInt',
  'Boolean',
  'Number',
  'String',
  'Symbol',
]);
const PRIMITIVE_GLOBALS: ReadonlySet<string> = new Set(['Infinity', 'NaN', 'undefined']);
const PRIMITIVE_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateExpression,
  SyntaxKind.TrueKeyword,
  SyntaxKind.TypeOfExpression,
  SyntaxKind.VoidExpression,
]);
const NON_PATTERN_KINDS: ReadonlySet<SyntaxKind> = new Set([
  ...PRIMITIVE_KINDS,
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.ClassExpression,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ObjectLiteralExpression,
]);
const PRIMITIVE_TYPES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.UndefinedKeyword,
]);
const PATTERN_CAPABLE_CONSTRUCTORS: ReadonlySet<string> = new Set(['Object', 'Proxy', 'RegExp']);

/** The global symbol a method key names, through aliases; none of another key or a shadowed Symbol. */
export function patternSymbolName(key: Expression): string | undefined {
  const path = globalPathOf(patternValue(key))?.join('.');
  return path !== undefined && INDEXING_SYMBOLS.has(path) ? path : undefined;
}

/**
 * Whether a symbol method advances a retained pattern. Search restores its previous index; split
 * and matchAll work on a clone. Global match and replace reset their index at both ends.
 */
export function symbolPatternChanges(method: string, receiver: Expression): boolean {
  return INDEXING_SYMBOLS.has(method) && isStickyPattern(receiver);
}

/** Whether a pattern is sticky without g, which match and replace advance between calls. */
export function isStickyPattern(node: Expression): boolean {
  const flags = flagsOf(node);
  return flags === null || (flags !== undefined && flags.includes('y') && !flags.includes('g'));
}

/** Whether exec and test keep a pattern's index between calls, through constants and copies. */
export function keepsPatternIndex(node: Expression): boolean {
  const flags = flagsOf(node);
  return flags === null || (flags !== undefined && (flags.includes('g') || flags.includes('y')));
}

/**
 * The flags of a pattern the code writes, copied too, following its constants; null of flags the
 * compile cannot read, which may keep an index, and none of what shows no pattern.
 */
function flagsOf(pattern: Expression): string | null | undefined {
  let value = unwrapped(pattern);
  const seen = new Set<Expression>();
  while (!seen.has(value)) {
    seen.add(value);
    value = patternValue(value);
    if (isRegularExpressionLiteral(value)) {
      return value.text.slice(value.text.lastIndexOf('/') + 1);
    }
    const given = patternArguments(value);
    if (given === undefined) {
      if (seen.size > 1) {
        return primitivePatternSource(value) ? '' : null;
      }
      return nonPatternValue(value) ? undefined : null;
    }
    const [source, flags] = given;
    if (flags !== undefined && globalPathOf(unwrapped(flags))?.join('.') !== 'undefined') {
      return writtenFlags(flags);
    }
    if (source === undefined) {
      return '';
    }
    value = unwrapped(source);
  }
  return null;
}

/** The flags written as text through constants, or null where they may keep an index. */
function writtenFlags(flags: Expression): string | null {
  const written = constantValue(flags, constInitializer);
  return typeof written === 'string' ? written : null;
}

/** Whether an expression is proven primitive, giving empty flags when passed to `RegExp(source)`. */
function primitivePatternSource(value: Expression): boolean {
  if (
    PRIMITIVE_KINDS.has(value.kind) ||
    PRIMITIVE_GLOBALS.has(globalPathOf(value)?.join('.') ?? '') ||
    constantValue(value, constInitializer) !== undefined
  ) {
    return true;
  }
  if (isCallExpression(value)) {
    return PRIMITIVE_CALLS.has(globalPathOf(patternValue(value.expression))?.join('.') ?? '');
  }
  if (!isIdentifier(value)) {
    return false;
  }
  const declared = frameDeclarationOf(value);
  return (
    declared !== undefined &&
    isParameterDeclaration(declared) &&
    isIdentifier(declared.name) &&
    declared.type !== undefined &&
    primitiveType(declared.type)
  );
}

/** Whether an expression cannot evaluate to a `RegExp` instance. */
function nonPatternValue(value: Expression): boolean {
  if (NON_PATTERN_KINDS.has(value.kind) || primitivePatternSource(value)) {
    return true;
  }
  if (isNewExpression(value)) {
    return nonPatternConstruction(value);
  }
  if (!isIdentifier(value)) {
    return false;
  }
  const declared = frameDeclarationOf(value);
  return (
    declared !== undefined && (isFunctionDeclaration(declared) || isClassDeclaration(declared))
  );
}

/** Whether `new Target(...)` constructs a class that cannot be or wrap a `RegExp`. */
function nonPatternConstruction(node: Expression & { readonly expression: Expression }): boolean {
  const callee = patternValue(node.expression);
  if (isClassExpression(callee)) {
    return callee.heritageClauses === undefined;
  }
  if (isIdentifier(callee)) {
    const declared = frameDeclarationOf(callee);
    if (declared !== undefined && isClassDeclaration(declared)) {
      return declared.heritageClauses === undefined;
    }
  }
  const path = globalPathOf(callee);
  const [root = ''] = path ?? [];
  const named = path?.join('.') ?? '';
  return (
    (BUILT_INS.has(root) || PLATFORM_ALIKE.has(root)) && !PATTERN_CAPABLE_CONSTRUCTORS.has(named)
  );
}

/** Whether a written type node allows only primitive values rather than pattern objects. */
function primitiveType(root: TypeNode): boolean {
  const stack: TypeNode[] = [root];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (isParenthesizedTypeNode(current)) {
      stack.push(current.type);
      continue;
    }
    if (isUnionTypeNode(current)) {
      stack.push(...current.types);
      continue;
    }
    if (!isLiteralTypeNode(current) && !PRIMITIVE_TYPES.has(current.kind)) {
      return false;
    }
  }
  return true;
}

/** What a constant identifier is initialized to; mutable or destructured bindings return none. */
function constInitializer(name: Identifier): Expression | undefined {
  const declared = frameDeclarationOf(name);
  return declared !== undefined &&
    isVariableDeclaration(declared) &&
    isIdentifier(declared.name) &&
    isVariableDeclarationList(declared.parent) &&
    /^const\b/u.test(declared.parent.getText(declared.getSourceFile()))
    ? declared.initializer
    : undefined;
}

/** What a pattern or symbol key's constant name is declared of, without following an alias twice. */
function patternValue(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = constInitializer(value);
    if (declared === undefined) {
      break;
    }
    value = unwrapped(declared);
  }
  return value;
}

/** What a construction or call of RegExp is given; none of another expression. */
function patternArguments(value: Expression): readonly Expression[] | undefined {
  return (isNewExpression(value) || isCallExpression(value)) &&
    globalPathOf(patternValue(value.expression))?.join('.') === 'RegExp'
    ? (value.arguments ?? [])
    : undefined;
}
