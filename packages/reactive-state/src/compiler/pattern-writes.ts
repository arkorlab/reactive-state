import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isFunctionDeclaration,
  isIdentifier,
  isLiteralTypeNode,
  isNewExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedTypeNode,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  isUnionTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  type ObjectLiteralElementLike,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { BUILT_INS, PLATFORM_ALIKE } from './built-ins.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedHeldValues } from './framed-held-members.ts';
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
  const pending: Expression[] = [key];
  const seen = new Set<Expression>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const value = unwrapped(current);
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    const path = globalPathOf(value)?.join('.');
    if (path !== undefined && INDEXING_SYMBOLS.has(path)) {
      return path;
    }
    pending.push(...symbolKeyCandidates(value));
  }
  return undefined;
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
      return unconstructedFlags(value, seen.size > 1);
    }
    const [source, flags] = given;
    const explicit = explicitPatternFlags(flags);
    if (explicit !== undefined) {
      return explicit;
    }
    if (source === undefined) {
      return '';
    }
    value = unwrapped(source);
  }
  return null;
}

/** Flags when `value` is not a literal or `RegExp(...)` construction. */
function unconstructedFlags(value: Expression, copied: boolean): string | null | undefined {
  if (copied) {
    return primitivePatternSource(value) ? '' : null;
  }
  return nonPatternValue(value) ? undefined : null;
}

/** Explicit 2nd-argument flags on `RegExp(source, flags)`, or `undefined` when omitted. */
function explicitPatternFlags(flags: Expression | undefined): string | null | undefined {
  if (flags === undefined || globalPathOf(unwrapped(flags))?.join('.') === 'undefined') {
    return undefined;
  }
  return writtenFlags(flags);
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

/** What a pattern's constant name is declared of, without following an alias twice. */
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

/** Candidate expressions that `value` can evaluate to when used as a bracketed symbol key. */
function symbolKeyCandidates(value: Expression): readonly Expression[] {
  if (isConditionalExpression(value)) {
    return [value.whenTrue, value.whenFalse];
  }
  return isIdentifier(value) ? identifierSymbolCandidates(value) : [];
}

/** Held initializers, assignments or parameter defaults reaching `name` at its read site. */
function identifierSymbolCandidates(name: Identifier): readonly Expression[] {
  const held = framedHeldValues(name, [], name);
  if (held !== undefined) {
    const entries = held.initial === undefined ? held.held : [held.initial, ...held.held];
    return entries.flatMap((entry) => selectedLiteralValues(entry.value, entry.keys));
  }
  const declared = frameDeclarationOf(name);
  return declared !== undefined &&
    isParameterDeclaration(declared) &&
    isIdentifier(declared.name) &&
    declared.initializer !== undefined
    ? [declared.initializer]
    : [];
}

/** Projects destructured `keys` across literal containers, or returns `[root]` when whole. */
function selectedLiteralValues(root: Expression, keys: readonly string[]): readonly Expression[] {
  let values: readonly Expression[] = [root];
  for (const key of keys) {
    values = values.flatMap((each) => literalStepValues(unwrapped(each), key));
  }
  return values;
}

/** Selects one static property or unshifted tuple slot `key` from `node`. */
function literalStepValues(node: Expression, key: string): readonly Expression[] {
  if (isArrayLiteralExpression(node)) {
    const slot = Number(key);
    if (
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      node.elements.slice(0, slot + 1).some((each) => isSpreadElement(each))
    ) {
      return [];
    }
    const item = node.elements[slot];
    return item === undefined ? [] : [item];
  }
  if (!isObjectLiteralExpression(node)) {
    return [];
  }
  const matches: Expression[] = [];
  for (const property of node.properties) {
    const value = objectPropertyValue(property, key);
    if (value !== undefined) {
      matches.push(value);
    }
  }
  return matches;
}

/** A static own property value matching `key` inside an object literal. */
function objectPropertyValue(
  property: ObjectLiteralElementLike,
  key: string,
): Expression | undefined {
  if (
    isPropertyAssignment(property) &&
    (isIdentifier(property.name) || isStringLiteral(property.name)) &&
    property.name.text === key
  ) {
    return property.initializer;
  }
  return isShorthandPropertyAssignment(property) &&
    isIdentifier(property.name) &&
    property.name.text === key
    ? property.name
    : undefined;
}
