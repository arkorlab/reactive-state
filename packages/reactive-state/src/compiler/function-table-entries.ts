import {
  type Expression,
  isArrowFunction,
  isClassExpression,
  isExpression,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { objectPostWrites } from './function-entry-writes.ts';
import {
  type EntryKind,
  holderObject,
  isPrototypeProperty,
  propertyKey,
  type ResolvedObject,
  type ScanContext,
  withBranch,
} from './function-property-resolution.ts';
import { type AssignedCallable } from './function-spread-callables.ts';

export {
  combineBranchKinds,
  type EntryKind,
  type FunctionKind,
  holderObject,
  isConstDeclaration,
  keyOf,
  type ResolvedObject,
  type ResolvedProperty,
  resolvePropertyValue,
  type ScanContext,
  withBranch,
} from './function-property-resolution.ts';

/** Surviving static-key classifications and spread/dynamic uncertainty across a table scan. */
interface TableScan {
  dynamicEntry: boolean;
  readonly entries: Map<string, EntryKind>;
  stickyRenamed: boolean;
  unverified: boolean;
}

const NON_FUNCTION: EntryKind = 'non-function';
const RAW_SCANS = new WeakMap<ObjectLiteralExpression, TableScan>();

/** Whether any surviving static key in `entries` has classification `target`. */
export function hasScanKind(entries: ReadonlyMap<string, EntryKind>, target: EntryKind): boolean {
  for (const [, kind] of entries) {
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
  return scan.unverified || scan.dynamicEntry || Object.hasOwn(Object.prototype, name)
    ? 'unknown'
    : NON_FUNCTION;
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
    seen: new Set([...context.seen, object]),
  };
  for (const property of object.properties) {
    if (isSpreadAssignment(property)) {
      mergeSpreadTable(unwrapped(property.expression), scan, local);
    } else {
      recordTableProperty(property, scan, local);
    }
  }
  applyPostDeclarationWrites(object, scan, local);
  if (local.hitCycle) {
    context.hitCycle = true;
  } else {
    RAW_SCANS.set(object, scan);
  }
  return scan;
}

/** Applies post-declaration mutations and visible assigned function values on `object` onto `scan`. */
function applyPostDeclarationWrites(
  object: ObjectLiteralExpression,
  scan: TableScan,
  context: ScanContext,
): void {
  const post = objectPostWrites(object);
  if (post.writes.all) {
    scan.unverified = true;
    degradeExistingEntries(scan.entries, 'unknown');
  } else {
    for (const key of post.writes.keys) {
      scan.entries.set(key, overwriteEntryKind(scan.entries.get(key), 'unknown'));
    }
  }
  for (const write of post.memberValues) {
    recordAssignedMemberValue(write, scan, context);
  }
  for (const source of post.assignSources) {
    recordObjectAssignSource(source, scan, context);
  }
}

/** Retains `'renamed'` evidence when a post-declaration member write installs a function value. */
function recordAssignedMemberValue(
  write: AssignedCallable,
  scan: TableScan,
  context: ScanContext,
): void {
  const kind = classifyAssignedNode(write.callable, context);
  if (kind !== 'entry' && kind !== 'renamed') {
    return;
  }
  if (write.key !== undefined) {
    scan.entries.set(write.key, 'renamed');
    return;
  }
  scan.stickyRenamed = true;
  degradeExistingEntries(scan.entries, 'renamed');
}

/** Classifies a direct or descriptor-installed member value node. */
function classifyAssignedNode(node: Node, context: ScanContext): EntryKind {
  if (isMethodDeclaration(node)) {
    return 'renamed';
  }
  return isExpression(node)
    ? withBranch(context, (branch) => branch.classifyExpression(node, branch))
    : 'unknown';
}

/** Propagates function entries from an `Object.assign(target, source)` spread argument onto `scan`. */
function recordObjectAssignSource(source: Expression, scan: TableScan, context: ScanContext): void {
  const inner = withBranch(context, (branch) => {
    const spread = holderObject(source, branch);
    return spread === undefined ? undefined : scanResolvedObject(spread, branch);
  });
  if (inner === undefined) {
    return;
  }
  for (const [key, kind] of inner.entries) {
    if (kind === 'entry' || kind === 'renamed') {
      scan.entries.set(key, 'renamed');
    }
  }
  if (inner.stickyRenamed || inner.dynamicEntry) {
    scan.stickyRenamed = true;
    degradeExistingEntries(scan.entries, 'renamed');
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
  if (each === NON_FUNCTION) {
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

/** Whether `node` receives its `.name` from an enclosing property assignment via `NamedEvaluation`. */
function isAnonymousDefinition(node: Expression): boolean {
  if (isArrowFunction(node)) {
    return true;
  }
  return (isFunctionExpression(node) || isClassExpression(node)) && node.name === undefined;
}
