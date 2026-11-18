import {
  type Expression,
  isArrowFunction,
  isClassExpression,
  isComputedPropertyName,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type PropertyName,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { declarationOf } from './framed.ts';
import { objectWrites } from './function-entry-writes.ts';

/** Whether a function's runtime `.name` comes from an unminified entry key or a minifiable binding. */
export type FunctionKind = 'entry' | 'renamed';

/** Classification of a present object property, spread entry, or binding arm. */
export type EntryKind = FunctionKind | 'non-function' | 'unknown';

/** Resolved object literal together with whether its binding chain is immutable (`const`). */
export interface ResolvedObject {
  readonly constant: boolean;
  readonly object: ObjectLiteralExpression;
}

/** Selected property expression or clean missing-key marker on a resolved object literal. */
export type ResolvedProperty =
  | { readonly kind: 'expr'; readonly value: Expression }
  | { readonly kind: 'missing-clean' }
  | { readonly kind: 'unknown' };

/** Surviving static-key classifications and spread/dynamic uncertainty across a table scan. */
interface TableScan {
  dynamicEntry: boolean;
  readonly entries: Map<string, EntryKind>;
  stickyRenamed: boolean;
  unverified: boolean;
}

/** Cycle-tracking context threaded through object and identifier resolution. */
export interface ScanContext {
  readonly classifyExpression: (node: Expression, context: ScanContext) => EntryKind;
  hitCycle: boolean;
  readonly seen: Set<Node>;
}

const RAW_SCANS = new WeakMap<ObjectLiteralExpression, TableScan>();

/** Runs `run` with an isolated copy of `context.seen`, propagating `hitCycle` back to `context`. */
export function withBranch<T>(context: ScanContext, run: (branch: ScanContext) => T): T {
  const branch: ScanContext = {
    classifyExpression: context.classifyExpression,
    hitCycle: false,
    seen: new Set(context.seen),
  };
  const result = run(branch);
  if (branch.hitCycle) {
    context.hitCycle = true;
  }
  return result;
}

/** Joins two candidate runtime branch classifications (`'non-function'` bottom, `'renamed'` top). */
export function combineBranchKinds(left: EntryKind, right: EntryKind): EntryKind {
  if (left === 'renamed' || right === 'renamed') {
    return 'renamed';
  }
  if (left === 'non-function') {
    return right;
  }
  if (right === 'non-function') {
    return left;
  }
  return left === right ? left : 'renamed';
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
  return (
    isVariableDeclarationList(declared.parent) &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
  );
}

/** Classifies static member `name` on `holder`, treating omitted clean own keys as `undefined`. */
export function memberEntryKind(holder: Expression, name: string, context: ScanContext): EntryKind {
  const resolved = holderObject(holder, context);
  if (resolved === undefined) {
    return 'unknown';
  }
  const scan = scanResolvedObject(resolved, context);
  const entry = scan.entries.get(name);
  if (entry !== undefined) {
    return entry;
  }
  if (scan.stickyRenamed) {
    return 'renamed';
  }
  return !scan.unverified && !scan.dynamicEntry && !(name in Object.prototype)
    ? 'non-function'
    : 'unknown';
}

/** Resolves the last static property initializer for `key` on an unchanged `const` object literal. */
export function resolvePropertyValue(
  holder: Expression,
  key: string,
  context: ScanContext,
): ResolvedProperty {
  const resolved = holderObject(holder, context);
  if (resolved === undefined || !resolved.constant) {
    return { kind: 'unknown' };
  }
  if (context.seen.has(resolved.object)) {
    context.hitCycle = true;
    return { kind: 'unknown' };
  }
  const writes = objectWrites(resolved.object);
  if (writes.all || writes.keys.has(key)) {
    return { kind: 'unknown' };
  }
  return withBranch(context, (branch) => {
    branch.seen.add(resolved.object);
    return findLastPropertyValue(resolved.object, key, branch);
  });
}

/** Walks `object.properties` right-to-left to locate the surviving value expression of `key`. */
function findLastPropertyValue(
  object: ObjectLiteralExpression,
  key: string,
  context: ScanContext,
): ResolvedProperty {
  for (let index = object.properties.length - 1; index >= 0; index -= 1) {
    const property = object.properties[index];
    if (property === undefined) {
      continue;
    }
    if (isSpreadAssignment(property)) {
      const inner = resolvePropertyValue(unwrapped(property.expression), key, context);
      if (inner.kind !== 'missing-clean') {
        return inner;
      }
      continue;
    }
    const propKey = propertyKey(property);
    if (isPrototypeProperty(property, propKey)) {
      if (unwrapped(property.initializer).kind !== SyntaxKind.NullKeyword) {
        return { kind: 'unknown' };
      }
      continue;
    }
    if (propKey === undefined) {
      return { kind: 'unknown' };
    }
    if (propKey === key) {
      return directPropertyValue(property);
    }
  }
  return key in Object.prototype ? { kind: 'unknown' } : { kind: 'missing-clean' };
}

/** Extracts the value expression of a matching static property or shorthand assignment. */
function directPropertyValue(property: ObjectLiteralElementLike): ResolvedProperty {
  if (isPropertyAssignment(property)) {
    return { kind: 'expr', value: unwrapped(property.initializer) };
  }
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    return { kind: 'expr', value: property.name };
  }
  return { kind: 'unknown' };
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
    classifyExpression: context.classifyExpression,
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
    return context.classifyExpression(value, context);
  }
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    return context.classifyExpression(property.name, context);
  }
  return 'unknown';
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
export function keyOf(name: PropertyName): string | undefined {
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
