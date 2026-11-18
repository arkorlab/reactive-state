import {
  type Expression,
  isArrowFunction,
  isBlock,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isSpreadAssignment,
  isStringLiteral,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { returnedBy } from './answers.ts';
import { framedDescriptorWrites } from './framed-descriptor-writes.ts';
import { framedObjectSources } from './framed-object-members.ts';
import {
  classifyResolvedSlotKeys,
  type GlobalWriteContext,
  resolveCallSlot,
  resolveCallTail,
  resolveSlotHolders,
} from './written-apply-slots.ts';
import { type CallArgument } from './written-arguments.ts';
import {
  type AliasLinks,
  type ArrayHolder,
  classifyPropertyName,
  type HolderArrayWrites,
  isPrototypeSetterProperty,
  markHoldersShortened,
  recordOwnersWrite,
} from './written-array-aliases.ts';
import {
  expandObjectLeaves,
  isPrimitiveNonObjectLeaf,
  OBJECT_ASSIGN_PATH,
  propertyValueExpressions,
  recordAssignSource,
} from './written-object-assign-writes.ts';
import { projectMemberKeys } from './written-slot-pushes.ts';

/**
 * Fixpoint resolution and descriptor extraction for `Reflect.set`, `Object.defineProperty`,
 * `Reflect.defineProperty`, `Object.defineProperties`, `Reflect.deleteProperty`, and `Object.assign`.
 */

export interface PendingGlobalWrite {
  readonly given: readonly CallArgument[];
  readonly path: string;
}

const MAX_GLOBAL_PASSES = 4;
const OBJECT_DEFINE_PROPERTIES_PATH = 'Object.defineProperties';
const OBJECT_DEFINE_PROPERTY_PATH = 'Object.defineProperty';
const REFLECT_DEFINE_PROPERTY_PATH = 'Reflect.defineProperty';
const REFLECT_DELETE_PROPERTY_PATH = 'Reflect.deleteProperty';
const REFLECT_SET_PATH = 'Reflect.set';
const REFLECT_SLOTS = {
  assignFirstSource: 1,
  key: 1,
  props: 1,
  receiver: 3,
  target: 0,
  value: 2,
} as const;
const GLOBAL_ARRAY_WRITERS: ReadonlySet<string> = new Set([
  OBJECT_ASSIGN_PATH,
  OBJECT_DEFINE_PROPERTIES_PATH,
  OBJECT_DEFINE_PROPERTY_PATH,
  REFLECT_DEFINE_PROPERTY_PATH,
  REFLECT_DELETE_PROPERTY_PATH,
  REFLECT_SET_PATH,
]);

/** Whether `path` names a global object/property writer that can mutate an array holder. */
export function isGlobalArrayWriter(path: string): boolean {
  return GLOBAL_ARRAY_WRITERS.has(path);
}

/** Iterates global array writers to a bounded fixpoint so mutated `.apply` lists propagate cleanly. */
export function drainGlobalArrayWrites(
  calls: readonly PendingGlobalWrite[],
  aliases: AliasLinks,
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): void {
  const ctx: GlobalWriteContext = { aliases, byHolder };
  for (let pass = 0; pass < MAX_GLOBAL_PASSES; pass += 1) {
    let changed = false;
    for (const item of calls) {
      const stepChanged = applyGlobalArrayWrite(item.path, item.given, ctx);
      changed ||= stepChanged;
    }
    if (!changed) {
      return;
    }
  }
}

/** Applies a single global property/descriptor/assign writer call against `ctx`. */
function applyGlobalArrayWrite(
  path: string,
  given: readonly CallArgument[],
  ctx: GlobalWriteContext,
): boolean {
  if (path === REFLECT_SET_PATH) {
    return applyReflectSetWrite(given, ctx);
  }
  if (path === OBJECT_DEFINE_PROPERTY_PATH || path === REFLECT_DEFINE_PROPERTY_PATH) {
    return applyDefinePropertyWrite(given, ctx);
  }
  if (path === OBJECT_DEFINE_PROPERTIES_PATH) {
    return applyDefinePropertiesWrite(given, ctx);
  }
  if (path === REFLECT_DELETE_PROPERTY_PATH) {
    const owners = resolveSlotHolders(given, [REFLECT_SLOTS.target], ctx);
    return markHoldersShortened(owners, ctx.byHolder);
  }
  return path === OBJECT_ASSIGN_PATH && applyObjectAssignWrite(given, ctx);
}

/** Records `Reflect.set` element writes and `'length'` resets on `target` and 4th-slot `receiver`. */
function applyReflectSetWrite(given: readonly CallArgument[], ctx: GlobalWriteContext): boolean {
  const owners = resolveSlotHolders(given, [REFLECT_SLOTS.target, REFLECT_SLOTS.receiver], ctx);
  if (owners.length === 0) {
    return false;
  }
  const keyItems = resolveCallSlot(given, REFLECT_SLOTS.key, ctx.byHolder);
  const keyInfo = classifyResolvedSlotKeys(keyItems);
  let changed = keyInfo.mayBeLength && markHoldersShortened(owners, ctx.byHolder);
  if (!keyInfo.mayBeIndex) {
    return changed;
  }
  const valueItems = resolveCallSlot(given, REFLECT_SLOTS.value, ctx.byHolder);
  for (const valItem of valueItems) {
    const didWrite = recordOwnersWrite(
      owners,
      {
        index: valItem.spread ? undefined : keyInfo.index,
        spread: valItem.spread,
        value: valItem.expression,
      },
      ctx.byHolder,
    );
    changed ||= didWrite;
  }
  return changed;
}

/** Records `Object.defineProperty` / `Reflect.defineProperty` `'length'` resets and descriptors. */
function applyDefinePropertyWrite(
  given: readonly CallArgument[],
  ctx: GlobalWriteContext,
): boolean {
  const owners = resolveSlotHolders(given, [REFLECT_SLOTS.target], ctx);
  if (owners.length === 0) {
    return false;
  }
  const keyItems = resolveCallSlot(given, REFLECT_SLOTS.key, ctx.byHolder);
  const keyInfo = classifyResolvedSlotKeys(keyItems);
  let changed = keyInfo.mayBeLength && markHoldersShortened(owners, ctx.byHolder);
  if (!keyInfo.mayBeIndex) {
    return changed;
  }
  const descItems = resolveCallSlot(given, REFLECT_SLOTS.value, ctx.byHolder);
  for (const descItem of descItems) {
    const didWrite = descItem.spread
      ? recordOwnersWrite(
          owners,
          { index: undefined, spread: false, value: descItem.expression },
          ctx.byHolder,
        )
      : recordDescriptorValues(descItem.expression, keyInfo.index, owners, ctx.byHolder);
    changed ||= didWrite;
  }
  return changed;
}

/** Records `Object.defineProperties(holder, props)` `'length'` resets and indexed descriptors. */
function applyDefinePropertiesWrite(
  given: readonly CallArgument[],
  ctx: GlobalWriteContext,
): boolean {
  const owners = resolveSlotHolders(given, [REFLECT_SLOTS.target], ctx);
  if (owners.length === 0) {
    return false;
  }
  let changed = false;
  const propsItems = resolveCallSlot(given, REFLECT_SLOTS.props, ctx.byHolder);
  for (const propsItem of propsItems) {
    if (propsItem.spread) {
      const didShorten = markHoldersShortened(owners, ctx.byHolder);
      const didWrite = recordOwnersWrite(
        owners,
        { index: undefined, spread: false, value: propsItem.expression },
        ctx.byHolder,
      );
      changed ||= didShorten || didWrite;
    } else {
      const didMap = recordDescriptorMap(propsItem.expression, owners, ctx);
      changed ||= didMap;
    }
  }
  return changed;
}

/** Records `Object.assign(holder, ...sources)` own enumerable object properties and array spreads. */
function applyObjectAssignWrite(given: readonly CallArgument[], ctx: GlobalWriteContext): boolean {
  const owners = resolveSlotHolders(given, [REFLECT_SLOTS.target], ctx);
  if (owners.length === 0) {
    return false;
  }
  let changed = false;
  const sourceItems = resolveCallTail(given, REFLECT_SLOTS.assignFirstSource, ctx.byHolder);
  for (const sourceItem of sourceItems) {
    if (sourceItem.spread) {
      const didShorten = markHoldersShortened(owners, ctx.byHolder);
      const didWrite = recordOwnersWrite(
        owners,
        { index: undefined, spread: true, value: sourceItem.expression },
        ctx.byHolder,
      );
      changed ||= didShorten || didWrite;
    } else {
      const didSource = recordAssignSource(sourceItem.expression, owners, ctx);
      changed ||= didSource;
    }
  }
  return changed;
}

/** Walks a `PropertyDescriptorMap` expression across branches, bindings and object spreads. */
function recordDescriptorMap(
  rootMap: Expression,
  owners: readonly ArrayHolder[],
  ctx: GlobalWriteContext,
): boolean {
  const pending: Expression[] = [rootMap];
  const seen = new Set<Expression>();
  let changed = false;
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    for (const leaf of expandObjectLeaves(current, seen)) {
      if (isPrimitiveNonObjectLeaf(leaf)) {
        continue;
      }
      if (isObjectLiteralExpression(leaf)) {
        const didObj = recordDescriptorMapLiteral(leaf, owners, pending, ctx.byHolder);
        changed ||= didObj;
      } else {
        const didShorten = markHoldersShortened(owners, ctx.byHolder);
        const didWrite = recordOwnersWrite(
          owners,
          { index: undefined, spread: false, value: leaf },
          ctx.byHolder,
        );
        changed ||= didShorten || didWrite;
      }
    }
  }
  return changed;
}

/** Inspects own entries and nested spreads of an `ObjectLiteralExpression` descriptor map. */
function recordDescriptorMapLiteral(
  literal: ObjectLiteralExpression,
  owners: readonly ArrayHolder[],
  pending: Expression[],
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): boolean {
  let changed = false;
  for (const prop of literal.properties) {
    if (isSpreadAssignment(prop)) {
      pending.push(prop.expression);
      continue;
    }
    if (isPrototypeSetterProperty(prop)) {
      continue;
    }
    const keyInfo = classifyPropertyName(prop.name);
    if (keyInfo.mayBeLength) {
      const didShorten = markHoldersShortened(owners, byHolder);
      changed ||= didShorten;
    }
    if (keyInfo.mayBeIndex) {
      for (const descExpr of propertyValueExpressions(prop)) {
        const didDesc = recordDescriptorValues(descExpr, keyInfo.index, owners, byHolder);
        changed ||= didDesc;
      }
    }
  }
  return changed;
}

/** Extracts `value` and `get` return expressions from a property descriptor expression. */
function recordDescriptorValues(
  descRoot: Expression,
  index: number | undefined,
  owners: readonly ArrayHolder[],
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): boolean {
  let changed = false;
  for (const mutatedVal of framedDescriptorWrites(descRoot)) {
    const didMut = recordOwnersWrite(owners, { index, spread: false, value: mutatedVal }, byHolder);
    changed ||= didMut;
  }
  const pending: Expression[] = [descRoot];
  const seen = new Set<Expression>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    for (const leaf of expandObjectLeaves(current, seen)) {
      const didLeaf = recordSingleDescriptorLeaf(leaf, index, owners, { byHolder, pending });
      changed ||= didLeaf;
    }
  }
  return changed;
}

/** Records data `value`s, accessor `get` returns or opaque fallback for one descriptor `leaf`. */
function recordSingleDescriptorLeaf(
  leaf: Expression,
  index: number | undefined,
  owners: readonly ArrayHolder[],
  state: {
    readonly byHolder: Map<ArrayHolder, HolderArrayWrites>;
    readonly pending: Expression[];
  },
): boolean {
  const valueEntries = framedObjectSources(leaf, ['value']);
  if (valueEntries === undefined) {
    return (
      !isPrimitiveNonObjectLeaf(leaf) &&
      recordOwnersWrite(owners, { index, spread: false, value: leaf }, state.byHolder)
    );
  }
  let changed = false;
  for (const entry of valueEntries) {
    if (entry.keys.length === 0) {
      const didVal = recordOwnersWrite(
        owners,
        { index, spread: false, value: entry.value },
        state.byHolder,
      );
      changed ||= didVal;
    } else if (entry.keys.length === 1 && entry.keys[0] === 'value') {
      state.pending.push(entry.value);
    } else {
      const projectedList = projectMemberKeys(entry.value, entry.keys);
      for (const projected of projectedList) {
        const didProj = recordOwnersWrite(
          owners,
          { index, spread: false, value: projected },
          state.byHolder,
        );
        changed ||= didProj;
      }
    }
  }
  const didGetters = recordDescriptorGetters(leaf, index, owners, state.byHolder);
  return changed || didGetters;
}

/** Records return expressions of `get: fn` or `get() { ... }` accessors on a descriptor `leaf`. */
function recordDescriptorGetters(
  leaf: Expression,
  index: number | undefined,
  owners: readonly ArrayHolder[],
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): boolean {
  let changed = false;
  const getEntries = framedObjectSources(leaf, ['get']);
  if (getEntries !== undefined) {
    for (const getEntry of getEntries) {
      if (getEntry.keys.length === 0) {
        const returns = callableReturnExpressions(getEntry.value);
        for (const ret of returns) {
          const didRet = recordOwnersWrite(owners, { index, spread: false, value: ret }, byHolder);
          changed ||= didRet;
        }
      }
    }
  }
  if (isObjectLiteralExpression(leaf)) {
    const didMethod = recordLiteralMethodGetters(leaf, index, owners, byHolder);
    changed ||= didMethod;
  }
  return changed;
}

/** Records return expressions from `get() { ... }` method syntax on an object-literal descriptor. */
function recordLiteralMethodGetters(
  literal: ObjectLiteralExpression,
  index: number | undefined,
  owners: readonly ArrayHolder[],
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): boolean {
  let changed = false;
  for (const prop of literal.properties) {
    if (
      isMethodDeclaration(prop) &&
      prop.body !== undefined &&
      (isIdentifier(prop.name) || isStringLiteral(prop.name)) &&
      prop.name.text === 'get'
    ) {
      const returns = returnedBy(prop);
      for (const ret of returns) {
        const didMethod = recordOwnersWrite(owners, { index, spread: false, value: ret }, byHolder);
        changed ||= didMethod;
      }
    }
  }
  return changed;
}

/** Return expressions of a getter function/arrow or fallback opaque callable expression. */
function callableReturnExpressions(fnRoot: Expression): readonly Expression[] {
  const results: Expression[] = [];
  const leaves = expandObjectLeaves(fnRoot, new Set());
  for (const leaf of leaves) {
    if (isArrowFunction(leaf)) {
      results.push(...(isBlock(leaf.body) ? returnedBy(leaf) : [leaf.body]));
    } else if (isFunctionExpression(leaf) || isFunctionDeclaration(leaf)) {
      if (leaf.body !== undefined) {
        results.push(...returnedBy(leaf));
      }
    } else if (!isPrimitiveNonObjectLeaf(leaf)) {
      results.push(leaf);
    }
  }
  return results;
}
