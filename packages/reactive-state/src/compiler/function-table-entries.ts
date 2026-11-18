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
  combineBranchKinds,
  type EntryKind,
  type FunctionKind,
  holderObject,
  isPrototypeProperty,
  propertyKey,
  type ResolvedObject,
  type ScanContext,
  withBranch,
} from './function-property-resolution.ts';
import {
  buildRestCopyTableScan,
  type RestTableCallbacks,
  type RestTableScan,
} from './function-rest-table-scans.ts';

export {
  combineBranchKinds,
  type EntryKind,
  type FunctionKind,
  holderObject,
  isConstDeclaration,
  keyOf,
  propertyKey,
  type ResolvedObject,
  type ResolvedProperty,
  resolvePropertyValue,
  type ScanContext,
  withBranch,
} from './function-property-resolution.ts';

/** Surviving static-key classifications and spread/dynamic uncertainty across a table scan. */
type TableScan = RestTableScan;

interface PostWriteState {
  readonly allWrites: boolean;
  readonly entries: Map<string, EntryKind>;
  readonly scan: TableScan;
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

/** Classifies a dynamic lookup across all entries of a written object literal or rest copy. */
export function dynamicObjectEntryKind(holder: Expression, context: ScanContext): EntryKind {
  const scan = scanObjectOrRestHolder(holder, context);
  if (scan === undefined) {
    return 'unknown';
  }
  return tableFunctionKind(scan) ?? 'unknown';
}

/** Classifies a dynamic lookup across all entries of `scan`. */
function tableFunctionKind(scan: TableScan): FunctionKind | undefined {
  if (scan.stickyRenamed || hasScanKind(scan.entries, 'renamed')) {
    return 'renamed';
  }
  if (scan.dynamicEntry || hasScanKind(scan.entries, 'entry')) {
    return scan.unverified || hasScanKind(scan.entries, 'unknown') ? 'renamed' : 'entry';
  }
  return undefined;
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
    optionalKeys: new Set(base.optionalKeys),
    stickyRenamed: base.stickyRenamed,
    unverified: true,
  };
}

/** Classifies static member `name` on `holder`, treating omitted clean own keys as `undefined`. */
export function memberEntryKind(holder: Expression, name: string, context: ScanContext): EntryKind {
  const scan = scanObjectOrRestHolder(holder, context);
  if (scan === undefined) {
    return 'unknown';
  }
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
    return {
      dynamicEntry: false,
      entries: new Map(),
      optionalKeys: new Set(),
      stickyRenamed: false,
      unverified: true,
    };
  }
  const scan: TableScan = {
    dynamicEntry: false,
    entries: new Map(),
    optionalKeys: new Set(),
    stickyRenamed: false,
    unverified: false,
  };
  const local: ScanContext = {
    classifyExpression: context.classifyExpression,
    hitCycle: false,
    mutableSpreadReachesFunction: context.mutableSpreadReachesFunction,
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
  const state: PostWriteState = { allWrites: post.writes.all, entries: new Map(), scan };
  let dynamicFunctionWrite = false;
  if (post.writes.all) {
    scan.unverified = true;
    degradeExistingEntries(scan.entries, 'unknown');
  } else {
    for (const key of post.writes.untrackedKeys) {
      joinPostKeyKind(key, 'unknown', state);
    }
  }
  for (const write of post.memberValues) {
    const each = classifyAssignedNode(write.callable, context);
    if (write.key === undefined) {
      if (each === 'entry' || each === 'renamed') {
        dynamicFunctionWrite = true;
      }
    } else {
      joinPostKeyKind(write.key, each, state);
    }
  }
  flushPostKeyKinds(state.entries, scan);
  if (dynamicFunctionWrite) {
    scan.stickyRenamed = true;
    degradeExistingEntries(scan.entries, 'renamed');
  }
  for (const source of post.assignSources) {
    recordObjectAssignSource(source, scan, context);
  }
}

/** Joins one post-declaration `added` classification onto `key`'s accumulated entry state. */
function joinPostKeyKind(key: string, added: EntryKind, state: PostWriteState): void {
  const current = state.entries.get(key) ?? initialPostKeyKind(key, state.allWrites, state.scan);
  state.entries.set(key, combineBranchKinds(current, added));
}

/** Computes the pre-write baseline classification for `key` before joining post-declaration writes. */
function initialPostKeyKind(key: string, allWrites: boolean, scan: TableScan): EntryKind {
  const base = scan.entries.get(key) ?? omittedKeyKind(key, scan);
  return allWrites ? combineBranchKinds(base, 'unknown') : base;
}

/** Pre-write classification of an omitted literal key `key` on `scan`. */
function omittedKeyKind(key: string, scan: TableScan): EntryKind {
  if (scan.stickyRenamed) {
    return 'renamed';
  }
  return scan.unverified || scan.dynamicEntry || Object.hasOwn(Object.prototype, key)
    ? 'unknown'
    : NON_FUNCTION;
}

/** Commits accumulated post-declaration key classifications onto `scan`. */
function flushPostKeyKinds(postState: ReadonlyMap<string, EntryKind>, scan: TableScan): void {
  for (const [key, combined] of postState) {
    scan.optionalKeys.add(key);
    scan.entries.set(key, combined === NON_FUNCTION ? 'unknown' : combined);
  }
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
  if (
    withBranch(context, (branch) => branch.mutableSpreadReachesFunction?.(source, branch) === true)
  ) {
    scan.stickyRenamed = true;
    degradeExistingEntries(scan.entries, 'renamed');
  }
  const inner = withBranch(context, (branch) => scanObjectOrRestHolder(source, branch));
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
    scan.optionalKeys.delete(key);
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
  const reachesMutable = withBranch(
    context,
    (branch) => branch.mutableSpreadReachesFunction?.(source, branch) === true,
  );
  const inner = withBranch(context, (branch) => scanObjectOrRestHolder(source, branch));
  if (inner === undefined) {
    scan.unverified = true;
    degradeExistingEntries(scan.entries, reachesMutable ? 'renamed' : 'unknown');
    if (reachesMutable) {
      scan.stickyRenamed = true;
    }
    return;
  }
  mergeSpreadFlags(inner, scan);
  if (inner.unverified) {
    mergeUnverifiedEntries(inner.entries, scan.entries);
  } else {
    for (const [key, kind] of inner.entries) {
      mergeVerifiedSpreadEntry(key, kind, inner.optionalKeys.has(key), scan);
    }
  }
  if (reachesMutable) {
    scan.stickyRenamed = true;
    degradeExistingEntries(scan.entries, 'renamed');
  }
}

/** Merges one static key `key` from a verified spread source onto `scan`. */
function mergeVerifiedSpreadEntry(
  key: string,
  kind: EntryKind,
  optionalOnSpread: boolean,
  scan: TableScan,
): void {
  const prev = scan.entries.get(key);
  if (optionalOnSpread) {
    if (prev === undefined) {
      scan.optionalKeys.add(key);
    }
    scan.entries.set(key, combineBranchKinds(prev ?? NON_FUNCTION, kind));
    return;
  }
  scan.optionalKeys.delete(key);
  scan.entries.set(key, overwriteEntryKind(prev, kind));
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

const REST_TABLE_CALLBACKS: RestTableCallbacks = {
  classifyAssignedNode,
  degradeExistingEntries,
  hasScanKind,
  omittedKeyKind,
  scanObjectLiteral,
  scanObjectOrRestHolder,
};

/** Resolves `holder` as either a direct/projected object literal or a bounded object-rest copy table. */
function scanObjectOrRestHolder(holder: Expression, context: ScanContext): TableScan | undefined {
  const resolved = withBranch(context, (branch) => holderObject(holder, branch));
  if (resolved !== undefined) {
    return scanResolvedObject(resolved, context);
  }
  return buildRestCopyTableScan(holder, context, REST_TABLE_CALLBACKS);
}
