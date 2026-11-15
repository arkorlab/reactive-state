import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isClassExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isTemplateExpression,
  isTypeOfExpression,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type PropertyName,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { declarationOf, takenApartOf } from './framed.ts';
import { elementEntryKey, objectWrites } from './function-entry-writes.ts';

/** Whether a function's runtime `.name` comes from an unminified entry key or a minifiable binding. */
export type FunctionKind = 'entry' | 'renamed';

/** Classification of a present object property or spread entry. */
type EntryKind = FunctionKind | 'non-function' | 'unknown';

/** Resolved object literal together with whether its binding chain is immutable (`const`). */
export interface ResolvedObject {
  readonly constant: boolean;
  readonly object: ObjectLiteralExpression;
}

/** Surviving static-key classifications and spread/dynamic uncertainty across a table scan. */
interface TableScan {
  dynamicEntry: boolean;
  readonly entries: Map<string, EntryKind>;
  stickyRenamed: boolean;
  unverified: boolean;
}

/** Cycle-tracking context threaded through object and identifier resolution. */
export interface ScanContext {
  readonly classifyFunction: (node: Expression, context: ScanContext) => FunctionKind | undefined;
  hitCycle: boolean;
  readonly seen: Set<Node>;
}

const RAW_SCANS = new WeakMap<ObjectLiteralExpression, TableScan>();

/** Runs `run` with an isolated copy of `context.seen`, propagating `hitCycle` back to `context`. */
function withBranch<T>(context: ScanContext, run: (branch: ScanContext) => T): T {
  const branch: ScanContext = {
    classifyFunction: context.classifyFunction,
    hitCycle: false,
    seen: new Set(context.seen),
  };
  const result = run(branch);
  if (branch.hitCycle) {
    context.hitCycle = true;
  }
  return result;
}

/** Whether any surviving static key in `entries` has classification `target`. */
export function hasScanKind(entries: ReadonlyMap<string, EntryKind>, target: EntryKind): boolean {
  for (const kind of entries.values()) {
    if (kind === target) {
      return true;
    }
  }
  return false;
}

/** Returns the table scan for `resolved`, degrading entries when `resolved` came through a `let`. */
export function scanResolvedObject(resolved: ResolvedObject, context: ScanContext): TableScan {
  const base = scanObjectLiteral(resolved.object, context);
  if (resolved.constant) {
    return base;
  }
  const entries = new Map(base.entries);
  degradeExistingEntries(entries, 'unknown');
  return {
    dynamicEntry: base.dynamicEntry,
    entries,
    stickyRenamed: base.stickyRenamed,
    unverified: true,
  };
}

/** Resolves an inline or lexically bound object literal expression. */
export function holderObject(holder: Expression, context: ScanContext): ResolvedObject | undefined {
  if (isObjectLiteralExpression(holder)) {
    return { constant: true, object: holder };
  }
  const declared = isIdentifier(holder) ? declarationOf(holder) : undefined;
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    declared.initializer === undefined
  ) {
    return undefined;
  }
  if (context.seen.has(declared)) {
    context.hitCycle = true;
    return undefined;
  }
  context.seen.add(declared);
  const inner = holderObject(unwrapped(declared.initializer), context);
  return inner === undefined
    ? undefined
    : { constant: inner.constant && isConstDeclaration(declared), object: inner.object };
}

/** Whether `declared` belongs to a `const` declaration list. */
export function isConstDeclaration(declared: VariableDeclaration): boolean {
  return /^const\s/u.test(declared.parent.getText(declared.getSourceFile()));
}

/** Whether `initializer` is the RHS of a `const` variable declaration. */
export function isConstInitializer(initializer: Expression): boolean {
  return isVariableDeclaration(initializer.parent) && isConstDeclaration(initializer.parent);
}

/** Scans and caches all properties, spreads, and post-declaration writes of `object`. */
function scanObjectLiteral(object: ObjectLiteralExpression, context: ScanContext): TableScan {
  const cached = RAW_SCANS.get(object);
  if (cached !== undefined) {
    return cached;
  }
  if (context.seen.has(object)) {
    context.hitCycle = true;
    return { dynamicEntry: false, entries: new Map(), stickyRenamed: false, unverified: true };
  }
  const scan: TableScan = {
    dynamicEntry: false,
    entries: new Map(),
    stickyRenamed: false,
    unverified: false,
  };
  const local: ScanContext = {
    classifyFunction: context.classifyFunction,
    hitCycle: false,
    seen: new Set(context.seen),
  };
  local.seen.add(object);
  for (const property of object.properties) {
    if (isSpreadAssignment(property)) {
      mergeSpreadTable(unwrapped(property.expression), scan, local);
    } else {
      recordTableProperty(property, scan, local);
    }
  }
  applyPostDeclarationWrites(object, scan);
  if (local.hitCycle) {
    context.hitCycle = true;
  } else {
    RAW_SCANS.set(object, scan);
  }
  return scan;
}

/** Applies post-declaration mutations recorded on `object` onto `scan`. */
function applyPostDeclarationWrites(object: ObjectLiteralExpression, scan: TableScan): void {
  const writes = objectWrites(object);
  if (writes.all) {
    scan.unverified = true;
    degradeExistingEntries(scan.entries, 'unknown');
    return;
  }
  for (const key of writes.keys) {
    scan.entries.set(key, overwriteEntryKind(scan.entries.get(key), 'unknown'));
  }
}

/** Records one static, computed, or prototype property into `scan`. */
function recordTableProperty(
  property: ObjectLiteralElementLike,
  scan: TableScan,
  context: ScanContext,
): void {
  const key = propertyKey(property);
  if (isPrototypeProperty(property, key)) {
    if (unwrapped(property.initializer).kind !== SyntaxKind.NullKeyword) {
      scan.unverified = true;
    }
    return;
  }
  const each = withBranch(context, (branch) => propertyEntryKind(property, key, branch));
  if (key !== undefined) {
    scan.entries.set(key, overwriteEntryKind(scan.entries.get(key), each));
    return;
  }
  recordComputedProperty(each, scan);
}

/** Updates `scan` for a dynamic computed property `[expr]: ...` of classification `each`. */
function recordComputedProperty(each: EntryKind, scan: TableScan): void {
  if (each === 'non-function') {
    return;
  }
  if (each === 'renamed') {
    scan.stickyRenamed = true;
    degradeExistingEntries(scan.entries, 'renamed');
    return;
  }
  if (each === 'entry') {
    scan.dynamicEntry = true;
    return;
  }
  scan.unverified = true;
  degradeExistingEntries(scan.entries, 'unknown');
}

/** Merges a spread source's surviving entries and uncertainty flags into `scan`. */
function mergeSpreadTable(source: Expression, scan: TableScan, context: ScanContext): void {
  const inner = withBranch(context, (branch) => {
    const spread = holderObject(source, branch);
    return spread === undefined ? undefined : scanResolvedObject(spread, branch);
  });
  if (inner === undefined) {
    scan.unverified = true;
    degradeExistingEntries(scan.entries, 'unknown');
    return;
  }
  mergeSpreadFlags(inner, scan);
  if (inner.unverified) {
    mergeUnverifiedEntries(inner.entries, scan.entries);
    return;
  }
  for (const [key, kind] of inner.entries) {
    scan.entries.set(key, overwriteEntryKind(scan.entries.get(key), kind));
  }
}

/** Propagates dynamic and unverified flags from spread `inner` onto `scan`. */
function mergeSpreadFlags(inner: TableScan, scan: TableScan): void {
  if (inner.unverified) {
    scan.unverified = true;
  }
  if (inner.dynamicEntry || (inner.unverified && hasScanKind(inner.entries, 'entry'))) {
    scan.dynamicEntry = true;
  }
  if (inner.stickyRenamed || (inner.unverified && hasScanKind(inner.entries, 'renamed'))) {
    scan.stickyRenamed = true;
    degradeExistingEntries(scan.entries, 'renamed');
    return;
  }
  if (inner.unverified) {
    degradeExistingEntries(scan.entries, 'unknown');
  }
}

/** Merges static keys from an unverified spread without letting uncertain entries clear functions. */
function mergeUnverifiedEntries(
  innerEntries: ReadonlyMap<string, EntryKind>,
  targetEntries: Map<string, EntryKind>,
): void {
  for (const [key, kind] of innerEntries) {
    const uncertain: EntryKind = kind === 'renamed' ? 'renamed' : 'unknown';
    targetEntries.set(key, overwriteEntryKind(targetEntries.get(key), uncertain));
  }
}

/** Combines an existing entry classification with an overwriting property classification `next`. */
function overwriteEntryKind(current: EntryKind | undefined, next: EntryKind): EntryKind {
  if (next === 'unknown') {
    return current === 'entry' || current === 'renamed' ? 'renamed' : 'unknown';
  }
  return next;
}

/** Applies a may-overwrite (`'renamed'` or `'unknown'`) across every existing key in `entries`. */
function degradeExistingEntries(
  entries: Map<string, EntryKind>,
  replacement: 'renamed' | 'unknown',
): void {
  for (const [key, current] of entries) {
    entries.set(key, overwriteEntryKind(current, replacement));
  }
}

/** Classifies a single object-literal property as `'entry'`, `'renamed'`, `'non-function'`, or `'unknown'`. */
function propertyEntryKind(
  property: ObjectLiteralElementLike,
  key: string | undefined,
  context: ScanContext,
): EntryKind {
  if (isMethodDeclaration(property)) {
    return 'entry';
  }
  if (isPropertyAssignment(property)) {
    const value = unwrapped(property.initializer);
    if (key !== undefined && key !== '__proto__' && isAnonymousDefinition(value)) {
      return 'entry';
    }
    return expressionEntryKind(value, context);
  }
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    return expressionEntryKind(property.name, context);
  }
  return 'unknown';
}

/** Classifies an arbitrary property value expression into `EntryKind`. */
function expressionEntryKind(value: Expression, context: ScanContext): EntryKind {
  const fn = withBranch(context, (branch) => branch.classifyFunction(value, branch));
  if (fn !== undefined) {
    return fn;
  }
  return withBranch(context, (branch) => isProvenNonFunction(value, branch))
    ? 'non-function'
    : 'unknown';
}

/** Whether `node` is guaranteed at runtime not to evaluate to a callable function or class. */
function isProvenNonFunction(node: Expression, context: ScanContext): boolean {
  if (isNonFunctionSyntax(node)) {
    return true;
  }
  if (isConditionalExpression(node)) {
    return (
      withBranch(context, (branch) => isProvenNonFunction(unwrapped(node.whenTrue), branch)) &&
      withBranch(context, (branch) => isProvenNonFunction(unwrapped(node.whenFalse), branch))
    );
  }
  if (isPropertyAccessExpression(node)) {
    return (
      resolvedEntryKind(unwrapped(node.expression), node.name.text, context) === 'non-function'
    );
  }
  if (isElementAccessExpression(node)) {
    const key = elementEntryKey(node);
    return (
      key !== undefined &&
      resolvedEntryKind(unwrapped(node.expression), key, context) === 'non-function'
    );
  }
  return isIdentifier(node) && isNonFunctionIdentifier(node, context);
}

/** Resolves a `const` variable or destructured entry binding to check whether it is non-callable. */
function isNonFunctionIdentifier(node: Identifier, context: ScanContext): boolean {
  const declared = declarationOf(node);
  if (declared !== undefined) {
    return isNonFunctionVariable(declared, context);
  }
  const taken = takenApartOf(node);
  if (taken === undefined || !isConstInitializer(taken.of)) {
    return false;
  }
  if (context.seen.has(taken.of)) {
    context.hitCycle = true;
    return false;
  }
  context.seen.add(taken.of);
  return resolvedEntryKind(unwrapped(taken.of), taken.key, context) === 'non-function';
}

/** Whether `declared` is an uncycled `const` binding initialized to a proven non-function. */
function isNonFunctionVariable(declared: Node, context: ScanContext): boolean {
  if (
    !isVariableDeclaration(declared) ||
    !isConstDeclaration(declared) ||
    declared.initializer === undefined
  ) {
    return false;
  }
  if (context.seen.has(declared)) {
    context.hitCycle = true;
    return false;
  }
  context.seen.add(declared);
  return isProvenNonFunction(unwrapped(declared.initializer), context);
}

/** Looks up the surviving `EntryKind` of static key `name` on `holder` when it is an object literal. */
function resolvedEntryKind(
  holder: Expression,
  name: string,
  context: ScanContext,
): EntryKind | undefined {
  const resolved = holderObject(holder, context);
  return resolved === undefined
    ? undefined
    : scanResolvedObject(resolved, context).entries.get(name);
}

/** Whether `node` is a container literal, primitive/regex literal, primitive unary operator, or `undefined`. */
function isNonFunctionSyntax(node: Expression): boolean {
  return (
    isObjectLiteralExpression(node) ||
    isArrayLiteralExpression(node) ||
    isPrimitiveOrRegexLiteral(node) ||
    isPrimitiveOperatorExpression(node) ||
    globalPathOf(node)?.join('.') === 'undefined'
  );
}

/** Whether `node` is a primitive, template, or regular-expression literal. */
function isPrimitiveOrRegexLiteral(node: Expression): boolean {
  return (
    isStringLiteral(node) ||
    isNoSubstitutionTemplateLiteral(node) ||
    isTemplateExpression(node) ||
    isNumericLiteral(node) ||
    isBigIntLiteral(node) ||
    isRegularExpressionLiteral(node) ||
    node.kind === SyntaxKind.TrueKeyword ||
    node.kind === SyntaxKind.FalseKeyword ||
    node.kind === SyntaxKind.NullKeyword
  );
}

/** Whether `node` applies a unary operator whose runtime result is always a primitive. */
function isPrimitiveOperatorExpression(node: Expression): boolean {
  return (
    isVoidExpression(node) ||
    isTypeOfExpression(node) ||
    isDeleteExpression(node) ||
    isPrefixUnaryExpression(node) ||
    isPostfixUnaryExpression(node)
  );
}

/** Whether `property` is a non-computed `__proto__: ...` prototype setter. */
function isPrototypeProperty(
  property: ObjectLiteralElementLike,
  key: string | undefined,
): property is PropertyAssignment {
  return (
    key === '__proto__' && isPropertyAssignment(property) && !isComputedPropertyName(property.name)
  );
}

/** Whether `node` receives its `.name` from an enclosing property assignment via `NamedEvaluation`. */
function isAnonymousDefinition(node: Expression): boolean {
  if (isArrowFunction(node)) {
    return true;
  }
  return (isFunctionExpression(node) || isClassExpression(node)) && node.name === undefined;
}

/** Static property key of an object literal element. */
function propertyKey(property: ObjectLiteralElementLike): string | undefined {
  if (isSpreadAssignment(property)) {
    return undefined;
  }
  if (isShorthandPropertyAssignment(property)) {
    return isIdentifier(property.name) ? property.name.text : undefined;
  }
  return keyOf(property.name);
}

/** The name of an entry the code writes: of a name, text, or a number; none of another. */
function keyOf(name: PropertyName): string | undefined {
  if (isComputedPropertyName(name)) {
    const value = unwrapped(name.expression);
    if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
      return value.text;
    }
    return isNumericLiteral(value) ? String(Number(value.text)) : undefined;
  }
  if (isNumericLiteral(name)) {
    return String(Number(name.text));
  }
  return isIdentifier(name) || isStringLiteral(name) ? name.text : undefined;
}
