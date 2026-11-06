import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isArrayLiteralExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { type AssignedFrameSource, iteratedFrameSources } from './framed-assignment-patterns.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix, framedKeyNames } from './framed-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { readsBinding } from './scope.ts';

/** Native entry construction installs each source-written value under its converted key. */
const FROM_ENTRIES: ReadonlySet<string> = new Set(['Object.fromEntries']);

/** A source-unshadowed native call retains its entry iterable rather than arbitrary factory fields. */
export function framedEntriesCall(node: Expression): node is CallExpression {
  return isCallExpression(node) && framedNativeConstructor(node.expression, FROM_ENTRIES);
}

interface EntryWork {
  readonly value: Expression;
  readonly seen: ReadonlySet<Node>;
}

/** Ordered literal entries and stable tuple spreads retain definite overwrites and possible keys. */
export function framedEntryValues(
  node: Expression,
  key: string,
): readonly AssignedFrameSource[] | undefined {
  if (!framedEntriesCall(node)) return undefined;
  const argument = framedArgumentPrefix(node, node.arguments, 1);
  const input = argument.values[0];
  if (input === undefined || argument.unknown) return undefined;
  const entries = framedAppliedArguments(node, input);
  if (entries === undefined) return undefined;
  const pending: EntryWork[] = entries.toReversed().map((value) => ({ value, seen: new Set() }));
  let found: AssignedFrameSource[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at.value);
    if (at.seen.has(value)) return undefined;
    const seen = new Set(at.seen).add(value);
    if (isSpreadElement(value)) {
      const spread = framedAppliedArguments(node, value.expression);
      if (spread === undefined) found.push(...spreadEntryValues(value.expression));
      else pending.push(...spread.toReversed().map((each) => ({ value: each, seen })));
      continue;
    }
    const selected = entryValue(node, value, key);
    if (selected.definite) found = selected.values;
    else found.push(...selected.values);
  }
  return found;
}

/** Each entry an opaque spread yields may supply its value slot under any key. */
function spreadEntryValues(iterable: Expression): readonly AssignedFrameSource[] {
  return iteratedFrameSources(iterable).map((entry) => ({ ...entry, keys: [...entry.keys, '1'] }));
}

interface EntrySelection {
  readonly definite: boolean;
  readonly values: AssignedFrameSource[];
}

/** An unknown entry key may replace the selected field, but cannot erase an earlier possible value. */
function entryValue(call: CallExpression, entry: Expression, key: string): EntrySelection {
  const tuple = framedAppliedArguments(call, entry) ?? packedEntryTuple(call, entry);
  if (tuple === undefined) return { definite: false, values: [{ value: entry, keys: ['1'] }] };
  const prefix = framedArgumentPrefix(call, tuple);
  const name = prefix.values[0];
  const value = prefix.values[1];
  if (name === undefined || value === undefined || prefix.unknown)
    return { definite: false, values: [{ value: entry, keys: ['1'] }] };
  const names = framedKeyNames(name);
  if (names !== undefined && !names.includes(key)) return { definite: false, values: [] };
  return { definite: names?.length === 1, values: [{ value, keys: [] }] };
}

/** A constant tuple packed into the known outer iterable retains its contents while unexposed. */
function packedEntryTuple(
  call: CallExpression,
  read: Expression,
): readonly Expression[] | undefined {
  const aliases = new Set<FrameBinding>();
  let value = unwrapped(read);
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || aliases.has(selected.binding))
      return undefined;
    const binding = selected.binding;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    aliases.add(binding);
    value = unwrapped(binding.initializer);
  }
  if (!isArrayLiteralExpression(value)) return undefined;
  return [...aliases].some((binding) => packedEntryExposed(call, read, binding, aliases))
    ? undefined
    : value.elements;
}

/** Packing this one source reference is data; other uses, effects and possible loop revisits lose it. */
function packedEntryExposed(
  call: CallExpression,
  read: Expression,
  binding: FrameBinding,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  const owner = executionOwner(call);
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node === call) continue;
    const local = node === call.getSourceFile() || executionOwner(node) === owner;
    const prior = node.end <= call.pos && !destructuredFirst(call, node);
    const repeated =
      local &&
      node.pos >= call.end &&
      repeatedFrameRead(node, call, binding, owner) &&
      framedPossibleBranch(node);
    if (node.pos >= binding.end && (prior || !local || repeated)) {
      if (local && packedEntryEffect(node)) return true;
      if (packedEntryReference(node, read, binding, aliases)) return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Earlier application work can expose entries; a later constructor or callback use is a reference. */
function packedEntryEffect(node: Node): boolean {
  return (
    isCallExpression(node) ||
    isNewExpression(node) ||
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node)
  );
}

/** Only the selected packing reference and whole constant alias declarations are transparent. */
function packedEntryReference(
  node: Node,
  read: Expression,
  binding: FrameBinding,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  if (
    node === read ||
    node === binding.name ||
    !isIdentifier(node) ||
    !readsBinding(node) ||
    frameBindingOf(node)?.binding !== binding
  )
    return false;
  const parent = node.parent;
  return !isVariableDeclaration(parent) || parent.initializer !== node || !aliases.has(parent);
}
