import { type Expression, type Node, type ObjectLiteralExpression } from 'typescript/ast';

import { type CycleSeenState } from './function-assignment-patterns.ts';
import { candidateObjectsWithCycle, type VariableWriteMap } from './function-candidate-objects.ts';
import { fileVariableWrites, retainedCallableWrites } from './function-entry-writes.ts';
import {
  EMPTY_EXCLUDED_KEYS,
  MAX_REST_COPY_CANDIDATES,
  type ObjectRestCopy,
  resolveObjectRestCopies,
} from './function-object-rest-copies.ts';
import {
  combineBranchKinds,
  type EntryKind,
  type ScanContext,
  withBranch,
} from './function-property-resolution.ts';
import { restTargetSafety } from './function-rest-target-writes.ts';
import { type CallableWrites } from './function-this-writes.ts';

/** Surviving static-key classifications and spread/dynamic uncertainty across a table scan. */
export interface RestTableScan {
  dynamicEntry: boolean;
  readonly entries: Map<string, EntryKind>;
  readonly optionalKeys: Set<string>;
  stickyRenamed: boolean;
  unverified: boolean;
}

/** Callbacks supplied by `function-table-entries.ts` to avoid circular module imports. */
export interface RestTableCallbacks {
  readonly classifyAssignedNode: (node: Node, context: ScanContext) => EntryKind;
  readonly degradeExistingEntries: (
    entries: Map<string, EntryKind>,
    replacement: 'renamed' | 'unknown',
  ) => void;
  readonly hasScanKind: (entries: ReadonlyMap<string, EntryKind>, target: EntryKind) => boolean;
  readonly omittedKeyKind: (key: string, scan: RestTableScan) => EntryKind;
  readonly scanObjectLiteral: (
    object: ObjectLiteralExpression,
    context: ScanContext,
  ) => RestTableScan;
  readonly scanObjectOrRestHolder: (
    holder: Expression,
    context: ScanContext,
  ) => RestTableScan | undefined;
}

const NON_FUNCTION: EntryKind = 'non-function';

/** Builds a `RestTableScan` from bounded object-rest copy candidates, refusing conservatively on overflow. */
export function buildRestCopyTableScan(
  source: Expression,
  context: ScanContext,
  callbacks: RestTableCallbacks,
): RestTableScan | undefined {
  const variableWrites = fileVariableWrites(source.getSourceFile());
  const cycle: CycleSeenState = { hitCycle: false, seen: new Set(context.seen) };
  const resolved = resolveObjectRestCopies(source, variableWrites, cycle);
  if (cycle.hitCycle) {
    context.hitCycle = true;
  }
  if (resolved.overflowed) {
    return overflowedTableScan();
  }
  if (resolved.copies.length === 0) {
    return undefined;
  }
  const copies = resolved.closed
    ? resolved.copies
    : expandUnclosedRestCandidates(source, resolved.copies, variableWrites, context);
  if (copies === undefined) {
    return overflowedTableScan();
  }
  const combined = joinRestCopyCandidateScans(copies, context, callbacks);
  const reachesWrittenFn = restTargetsWriteFunction(resolved.targets, context, callbacks);
  if (!reachesWrittenFn && resolved.closed && !cycle.hitCycle) {
    return combined;
  }
  callbacks.degradeExistingEntries(combined.entries, reachesWrittenFn ? 'renamed' : 'unknown');
  const optionalKeys = new Set(combined.optionalKeys);
  for (const key of combined.entries.keys()) {
    optionalKeys.add(key);
  }
  return {
    dynamicEntry: combined.dynamicEntry,
    entries: combined.entries,
    optionalKeys,
    stickyRenamed: combined.stickyRenamed || reachesWrittenFn,
    unverified: true,
  };
}

function overflowedTableScan(): RestTableScan {
  return {
    dynamicEntry: false,
    entries: new Map(),
    optionalKeys: new Set(),
    stickyRenamed: true,
    unverified: true,
  };
}

/** Checks whether any in-place property write or `Object.assign` source on `targets` reaches a function. */
function restTargetsWriteFunction(
  targets: ReadonlySet<Node>,
  context: ScanContext,
  callbacks: RestTableCallbacks,
): boolean {
  for (const target of targets) {
    if (context.seen.has(target)) {
      context.hitCycle = true;
      continue;
    }
    const triggered = withBranch(context, (branch) => {
      branch.seen.add(target);
      return singleRestTargetWritesFunction(target, branch, callbacks);
    });
    if (triggered) {
      return true;
    }
  }
  return false;
}

function singleRestTargetWritesFunction(
  target: Node,
  context: ScanContext,
  callbacks: RestTableCallbacks,
): boolean {
  const safety = restTargetSafety(target.getSourceFile());
  const writtenValues = safety.writtenValues.get(target);
  if (writtenValues !== undefined) {
    for (const written of writtenValues) {
      const kind = callbacks.classifyAssignedNode(written, context);
      if (kind === 'entry' || kind === 'renamed') {
        return true;
      }
    }
  }
  const assignSources = safety.assignSources.get(target);
  if (assignSources === undefined) {
    return false;
  }
  for (const assignSrc of assignSources) {
    const inner = withBranch(context, (branch) =>
      callbacks.scanObjectOrRestHolder(assignSrc, branch),
    );
    if (
      inner?.stickyRenamed === true ||
      inner?.dynamicEntry === true ||
      (inner !== undefined &&
        (callbacks.hasScanKind(inner.entries, 'entry') ||
          callbacks.hasScanKind(inner.entries, 'renamed'))) ||
      withBranch(
        context,
        (branch) => branch.mutableSpreadReachesFunction?.(assignSrc, branch) === true,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Includes direct `ObjectLiteralExpression` branch candidates alongside unclosed rest copies. */
function expandUnclosedRestCandidates(
  source: Expression,
  copies: readonly ObjectRestCopy[],
  variableWrites: VariableWriteMap,
  context: ScanContext,
): readonly ObjectRestCopy[] | undefined {
  const cycle: CycleSeenState = { hitCycle: false, seen: new Set(context.seen) };
  const direct = candidateObjectsWithCycle(source, variableWrites, cycle);
  if (cycle.hitCycle) {
    context.hitCycle = true;
  }
  if (direct.length === 0) {
    return copies;
  }
  if (copies.length + direct.length > MAX_REST_COPY_CANDIDATES) {
    return undefined;
  }
  return [...copies, ...direct.map((object) => ({ excludedKeys: EMPTY_EXCLUDED_KEYS, object }))];
}

/** Joins projected `RestTableScan`s across alternative `ObjectRestCopy` runtime candidates. */
function joinRestCopyCandidateScans(
  copies: readonly ObjectRestCopy[],
  context: ScanContext,
  callbacks: RestTableCallbacks,
): RestTableScan {
  const scans = copies.map((copy) => projectRestCopyCandidate(copy, context, callbacks));
  const allKeys = new Set<string>();
  let dynamicEntry = false;
  let stickyRenamed = false;
  let unverified = false;
  for (const item of scans) {
    dynamicEntry ||= item.dynamicEntry;
    stickyRenamed ||= item.stickyRenamed;
    unverified ||= item.unverified;
    for (const key of item.entries.keys()) {
      allKeys.add(key);
    }
  }
  const entries = new Map<string, EntryKind>();
  const optionalKeys = new Set<string>();
  for (const key of allKeys) {
    let kind: EntryKind = NON_FUNCTION;
    let optional = false;
    for (const item of scans) {
      const present = item.entries.get(key);
      if (present === undefined) {
        optional = true;
        kind = combineBranchKinds(kind, callbacks.omittedKeyKind(key, item));
      } else {
        optional ||= item.optionalKeys.has(key);
        kind = combineBranchKinds(kind, present);
      }
    }
    entries.set(key, kind);
    if (optional) {
      optionalKeys.add(key);
    }
  }
  return { dynamicEntry, entries, optionalKeys, stickyRenamed, unverified };
}

/** Filters excluded sibling keys from `copy.object`'s scan and re-applies retained `this` writes. */
function projectRestCopyCandidate(
  copy: ObjectRestCopy,
  context: ScanContext,
  callbacks: RestTableCallbacks,
): RestTableScan {
  const raw = callbacks.scanObjectLiteral(copy.object, context);
  const { excludedKeys } = copy;
  if (excludedKeys.size === 0) {
    return raw;
  }
  const entries = new Map<string, EntryKind>();
  for (const [key, kind] of raw.entries) {
    if (!excludedKeys.has(key)) {
      entries.set(key, kind);
    }
  }
  const optionalKeys = new Set<string>();
  for (const key of raw.optionalKeys) {
    if (!excludedKeys.has(key)) {
      optionalKeys.add(key);
    }
  }
  const projected: RestTableScan = {
    dynamicEntry: raw.dynamicEntry,
    entries,
    optionalKeys,
    stickyRenamed: raw.stickyRenamed,
    unverified: raw.unverified,
  };
  applyRetainedCallableWrites(
    retainedCallableWrites(copy.object, excludedKeys),
    projected,
    context,
    callbacks,
  );
  return projected;
}

interface RetainedPostState {
  readonly allWrites: boolean;
  readonly callbacks: RestTableCallbacks;
  readonly postEntries: Map<string, EntryKind>;
  readonly scan: RestTableScan;
}

/** Re-applies `this` writes from retained callables onto `scan` after `excludedKeys` projection. */
function applyRetainedCallableWrites(
  viaThis: CallableWrites,
  scan: RestTableScan,
  context: ScanContext,
  callbacks: RestTableCallbacks,
): void {
  const state: RetainedPostState = {
    allWrites: viaThis.all,
    callbacks,
    postEntries: new Map(),
    scan,
  };
  let dynamicFunctionWrite = false;
  if (viaThis.all) {
    scan.unverified = true;
    callbacks.degradeExistingEntries(scan.entries, 'unknown');
  } else {
    for (const key of viaThis.untrackedKeys) {
      joinRetainedPostKey(key, 'unknown', state);
    }
  }
  for (const write of viaThis.assignments) {
    const each = callbacks.classifyAssignedNode(write.value, context);
    if (write.key === undefined) {
      if (each === 'entry' || each === 'renamed') {
        dynamicFunctionWrite = true;
      }
    } else {
      joinRetainedPostKey(write.key, each, state);
    }
  }
  for (const [key, combined] of state.postEntries) {
    scan.optionalKeys.add(key);
    scan.entries.set(key, combined === NON_FUNCTION ? 'unknown' : combined);
  }
  if (dynamicFunctionWrite) {
    scan.stickyRenamed = true;
    callbacks.degradeExistingEntries(scan.entries, 'renamed');
  }
}

function joinRetainedPostKey(key: string, added: EntryKind, state: RetainedPostState): void {
  let base = state.postEntries.get(key);
  if (base === undefined) {
    const rawBase = state.scan.entries.get(key) ?? state.callbacks.omittedKeyKind(key, state.scan);
    base = state.allWrites ? combineBranchKinds(rawBase, 'unknown') : rawBase;
  }
  state.postEntries.set(key, combineBranchKinds(base, added));
}
