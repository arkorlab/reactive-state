import {
  type BinaryExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isClassExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isTemplateExpression,
  isTypeOfExpression,
  isVoidExpression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, returnedBy } from './answers.ts';
import { globalOf, unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { metadataInitializer } from './input-callees.ts';
import { rootOf, targetsOf } from './kept.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { writtenBy } from './written.ts';

/** Source-written values that can carry a Proxy to a measured call result or container entry. */
export interface ProxyReading {
  readonly follow?: Resolve;
  readonly functionOf?: (callee: Expression) => Answering | undefined;
}

/** Active source invocation frame mapping parameters to caller argument origins. */
export interface Frame {
  readonly fn: Answering;
  readonly given: readonly Origin[] | undefined;
}

/** Call-stack state carried alongside an expression during Proxy origin traversal. */
export interface Context extends ProxyReading {
  readonly calls: ReadonlySet<Node>;
  readonly frames: readonly Frame[];
}

/** Candidate expression state, optional member projection path, and active spread context. */
export interface Origin {
  readonly value: Expression;
  readonly keys: readonly string[];
  readonly context: Context;
  readonly seen: ReadonlySet<Expression>;
  readonly spread?: boolean | undefined;
  readonly excluded?: ReadonlySet<string> | undefined;
}

/** A lexical constant's initializer, or a source module's imported constant. */
export function heldConstant(name: Identifier, context: ProxyReading): Expression | undefined {
  return metadataInitializer(name) ?? context.follow?.(name);
}

/** Ordinary property names are literal, and computed names follow primitive constant keys. */
export function propertyKey(name: PropertyName, reading: ProxyReading): string | undefined {
  if (isIdentifier(name)) {
    return name.text;
  }
  return isComputedPropertyName(name) ? originKey(name.expression, reading) : literalKey(name);
}

/** A key whose source is a literal, without application conversion or evaluation. */
export function originKey(value: Expression, reading: ProxyReading): string | undefined {
  return literalKey(sourceValue(value, reading));
}

/** A written boolean or nullish condition, without executing application code. */
export function literalTruth(value: Expression): boolean | undefined {
  if (value.kind === SyntaxKind.TrueKeyword) {
    return true;
  }
  return value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword ||
    globalOf(value) === 'undefined'
    ? false
    : undefined;
}

/** A lexical constant followed without executing application code or constructing compiler modules. */
export function sourceValue(node: Expression, reading: ProxyReading): Expression {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const held = heldConstant(value, reading);
    if (held === undefined) {
      break;
    }
    value = unwrapped(held);
  }
  return value;
}

/** A global callee reached through lexical aliases and source-written member keys. */
export function sourcePath(node: Expression, reading: ProxyReading): string | undefined {
  const keys: string[] = [];
  const seen = new Set<Expression>();
  let value = sourceValue(node, reading);
  while (!seen.has(value)) {
    seen.add(value);
    const path = globalPathOf(value);
    if (path !== undefined) {
      return [...path, ...keys].join('.');
    }
    if (isPropertyAccessExpression(value)) {
      keys.unshift(value.name.text);
    } else if (isElementAccessExpression(value)) {
      const key = originKey(value.argumentExpression, reading);
      if (key === undefined) {
        return undefined;
      }
      keys.unshift(key);
    } else {
      return undefined;
    }
    value = sourceValue(value.expression, reading);
  }
  return undefined;
}

/** A key represented by source text or a number alone. */
function literalKey(node: Node): string | undefined {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) || isNumericLiteral(node)
    ? node.text
    : undefined;
}

/** A prior explicit write prevents projecting a captured literal's original data entries. */
export function writtenBefore(name: Identifier, reading: ProxyReading): boolean {
  const declared = metadataInitializer(name)?.parent;
  if (declared === undefined) {
    return false;
  }
  const visit = (node: Node): boolean => {
    if (node.pos >= name.pos || node.end <= declared.end) {
      return false;
    }
    const target = writtenBy(node);
    if (
      target !== undefined &&
      targetsOf(target).some((each) => {
        const root = rootOf(each);
        return root !== undefined && sourceValue(root, reading) === sourceValue(name, reading);
      })
    ) {
      return true;
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return visit(name.getSourceFile());
}

/** Keys guaranteed to be copied as own enumerable properties when spreading `node`. */
export function guaranteedSpreadKeys(
  node: Expression,
  reading: ProxyReading,
  seen = new Set<Expression>(),
): ReadonlySet<string> {
  const literal = unmutatedObjectLiteral(node, reading, seen);
  if (literal === undefined) {
    return new Set();
  }
  const following = new Set([...seen, literal]);
  const keys = new Set<string>();
  for (const property of literal.properties) {
    for (const each of spreadEntryKeys(property, reading, following)) {
      keys.add(each);
    }
  }
  return keys;
}

/** Resolves `node` to an unmutated object literal initializer when statically known. */
function unmutatedObjectLiteral(
  node: Expression,
  reading: ProxyReading,
  seen: ReadonlySet<Expression>,
): ObjectLiteralExpression | undefined {
  let current = unwrapped(node);
  const visited = new Set(seen);
  while (isIdentifier(current) && !visited.has(current)) {
    if (writtenBefore(current, reading)) {
      return undefined;
    }
    visited.add(current);
    const held = heldConstant(current, reading);
    if (held === undefined) {
      return undefined;
    }
    current = unwrapped(held);
  }
  return isObjectLiteralExpression(current) && !visited.has(current) ? current : undefined;
}

/** Guaranteed own enumerable keys contributed by one object literal element during spread. */
function spreadEntryKeys(
  property: ObjectLiteralElementLike,
  reading: ProxyReading,
  seen: Set<Expression>,
): ReadonlySet<string> {
  if (isSpreadAssignment(property)) {
    return guaranteedSpreadKeys(property.expression, reading, seen);
  }
  if (
    isPropertyAssignment(property) ||
    isShorthandPropertyAssignment(property) ||
    isGetAccessorDeclaration(property) ||
    isSetAccessorDeclaration(property) ||
    isMethodDeclaration(property)
  ) {
    const key = propertyKey(property.name, reading);
    if (key !== undefined && (isComputedPropertyName(property.name) || key !== '__proto__')) {
      return new Set([key]);
    }
  }
  return new Set();
}

/** Own data entries are measured; an accessor is executed when selected or copied by spread. */
export function objectOrigins(object: ObjectLiteralExpression, at: Origin): readonly Origin[] {
  const [key, ...rest] = at.keys;
  if (key === undefined) {
    return dataOrigins(object, at);
  }
  return selectedPropertyOrigins(object, key, { ...at, keys: rest });
}

/** Candidate origins for a specific selected `key` across spreads, computed keys, and own fields. */
function selectedPropertyOrigins(
  object: ObjectLiteralExpression,
  key: string,
  restOrigin: Origin,
): readonly Origin[] {
  const found: Origin[] = [];
  let setter = false;
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      if (!setter) {
        found.push({
          ...restOrigin,
          excluded: undefined,
          keys: [key, ...restOrigin.keys],
          spread: undefined,
          value: property.expression,
        });
      }
      if (guaranteedSpreadKeys(property.expression, restOrigin.context).has(key)) {
        break;
      }
      continue;
    }
    const named = propertyKey(property.name, restOrigin.context);
    if (named === undefined) {
      found.push(...memberPropertyOrigins(property, restOrigin, setter));
      continue;
    }
    if (named !== key) {
      continue;
    }
    if (isSetAccessorDeclaration(property)) {
      setter = true;
      continue;
    }
    found.push(...memberPropertyOrigins(property, restOrigin, setter));
    break;
  }
  return found;
}

/** Origins contributed when reading a matching or dynamically named object literal member. */
function memberPropertyOrigins(
  property: ObjectLiteralElementLike,
  at: Origin,
  setter: boolean,
): readonly Origin[] {
  if (isGetAccessorDeclaration(property)) {
    return returnedBy(property).map((value) => ({ ...at, value }));
  }
  return setter ? [] : dataProperty(property, at);
}

/** Surviving data entries and spread sources; spread sources also evaluate own getters. */
function dataOrigins(object: ObjectLiteralExpression, at: Origin): readonly Origin[] {
  const found: Origin[] = [];
  const seen = new Set<string>(at.excluded);
  const setters = new Set<string>();
  const entryAt: Origin = { ...at, excluded: undefined, spread: undefined };
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      found.push({ ...at, excluded: new Set(seen), spread: true, value: property.expression });
      for (const guaranteed of guaranteedSpreadKeys(property.expression, at.context)) {
        seen.add(guaranteed);
      }
      continue;
    }
    const key = propertyKey(property.name, at.context);
    if (key === undefined) {
      found.push(...unkeyedEntryOrigins(property, entryAt, at.spread === true));
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    if (isSetAccessorDeclaration(property)) {
      setters.add(key);
      continue;
    }
    seen.add(key);
    if (!setters.has(key) || isGetAccessorDeclaration(property)) {
      found.push(...unkeyedEntryOrigins(property, entryAt, at.spread === true));
    }
  }
  return found;
}

/** Value origins read from one object literal entry during whole-object measurement or spread. */
function unkeyedEntryOrigins(
  property: ObjectLiteralElementLike,
  entryAt: Origin,
  invokesGetter: boolean,
): readonly Origin[] {
  if (isGetAccessorDeclaration(property)) {
    return invokesGetter ? returnedBy(property).map((value) => ({ ...entryAt, value })) : [];
  }
  return dataProperty(property, entryAt);
}

/** A data entry's value, rather than a deferred accessor or method body. */
function dataProperty(property: ObjectLiteralElementLike, at: Origin): readonly Origin[] {
  if (isPropertyAssignment(property)) {
    return [{ ...at, value: property.initializer }];
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? [{ ...at, value: property.name }]
    : [];
}

/** Built-in calls whose completion value is never `undefined`. */
const DEFINED_CALLS: ReadonlySet<string> = new Set([
  'Boolean',
  'Number',
  'Proxy.revocable',
  'String',
  'Symbol',
]);

/** Classifies whether an argument origin is guaranteed `undefined`, defined, or possibly either. */
export function argumentPresence(given: Origin): 'defined' | 'possible' | 'undefined' {
  if (given.keys.length > 0) {
    return 'possible';
  }
  const value = sourceValue(given.value, given.context);
  if (isVoidExpression(value) || globalOf(value) === 'undefined') {
    return 'undefined';
  }
  return guaranteedDefined(value, given.context, new Set(), true) ? 'defined' : 'possible';
}

/** Checks whether `node` never evaluates to `undefined` (or `null` when `!nullable`). */
function guaranteedDefined(
  node: Expression,
  reading: ProxyReading,
  seen: ReadonlySet<Expression>,
  nullable: boolean,
): boolean {
  const value = sourceValue(node, reading);
  if (seen.has(value)) {
    return false;
  }
  const following = new Set([...seen, value]);
  if (constantValue(value) !== undefined || nonUndefinedLeaf(value, nullable)) {
    return true;
  }
  if (isConditionalExpression(value)) {
    return (
      guaranteedDefined(value.whenTrue, reading, following, nullable) &&
      guaranteedDefined(value.whenFalse, reading, following, nullable)
    );
  }
  if (isBinaryExpression(value)) {
    return guaranteedDefinedBinary(value, reading, following, nullable);
  }
  return isCallExpression(value) && DEFINED_CALLS.has(sourcePath(value.expression, reading) ?? '');
}

/** Checks binary operators whose result is guaranteed non-`undefined`. */
function guaranteedDefinedBinary(
  value: BinaryExpression,
  reading: ProxyReading,
  seen: Set<Expression>,
  nullable: boolean,
): boolean {
  const kind = value.operatorToken.kind;
  if (kind === SyntaxKind.CommaToken || kind === SyntaxKind.BarBarToken) {
    return guaranteedDefined(value.right, reading, seen, nullable);
  }
  if (kind === SyntaxKind.QuestionQuestionToken) {
    return (
      guaranteedDefined(value.left, reading, seen, false) ||
      guaranteedDefined(value.right, reading, seen, nullable)
    );
  }
  return (
    kind === SyntaxKind.AmpersandAmpersandToken &&
    guaranteedDefined(value.left, reading, seen, nullable) &&
    guaranteedDefined(value.right, reading, seen, nullable)
  );
}

/** Checks literal, unary, and constructed expressions that never evaluate to `undefined`. */
function nonUndefinedLeaf(value: Expression, nullable: boolean): boolean {
  return (
    (nullable && value.kind === SyntaxKind.NullKeyword) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    isBigIntLiteral(value) ||
    isTemplateExpression(value) ||
    isRegularExpressionLiteral(value) ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value) ||
    isNewExpression(value) ||
    isTypeOfExpression(value) ||
    isPrefixUnaryExpression(value) ||
    isPostfixUnaryExpression(value)
  );
}
