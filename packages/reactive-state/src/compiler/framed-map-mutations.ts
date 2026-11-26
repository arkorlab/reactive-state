import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isIfStatement,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { framedOwnMethod, framedReceiverDispatch } from './framed-at-methods.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import {
  framedStoredValues,
  framedUnprovenValues,
  type MapValues,
  type MapWrite,
} from './framed-map-stores.ts';
import { framedNativeArguments, framedUnresolvedCall } from './framed-native-arguments.ts';
import { framedCondition, framedNativeConstructor } from './framed-sources.ts';
import { weakMapWritesQuiet } from './framed-weak-map-guards.ts';
import { framedMutationKey } from './framed-weak-map-keys.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Native Map writes retain possible selected values without simulating arbitrary collection state. */

const MAPS = new Set(['Map', 'WeakMap']);
const WEAKS = new Set(['WeakMap']);
const SETTERS = new Set(['Map.prototype.set', 'WeakMap.prototype.set']);
const GETTERS = new Set(['Map.prototype.get', 'WeakMap.prototype.get']);

interface MapSource {
  readonly construction: NewExpression | undefined;
  readonly bindings: ReadonlySet<FrameBinding>;
  readonly sets: readonly CallExpression[];
}

interface SetSource {
  readonly receiver: Expression;
  readonly key: Expression | undefined;
  readonly value: Expression | undefined;
  readonly borrowed: boolean;
  readonly omittedValue: boolean;
}

type MapIdentity = (value: Expression) => MapSource | undefined;

/** Whether a call may run the native method, surely does, or runs an own one acting on the Map. */
interface MethodReach {
  readonly possible: boolean;
  readonly certain: boolean;
  readonly open: boolean;
}

interface MutationContext {
  readonly key: Expression | undefined;
  readonly initial: readonly Expression[] | undefined;
  readonly identity: MapIdentity;
  /** An own get that acts on the Map may answer any entry, so every write counts, any key. */
  readonly anyEntry: boolean;
}

interface WriteContext {
  readonly weak: boolean;
  readonly read: CallExpression;
  readonly selected: MapSource;
  readonly wanted: string | undefined;
  readonly exact: boolean;
  readonly identity: MapIdentity;
}

interface MethodAssignment {
  readonly node: BinaryExpression;
  readonly exact: boolean;
}

interface MethodUse {
  readonly read: CallExpression;
  readonly definite: BinaryExpression;
  readonly selected: MapSource;
  readonly identity: MapIdentity;
  readonly method: string;
  readonly receiver: Expression | undefined;
}

/** Direct set calls and explicit native borrowing retain their consumed receiver, key and value. */
export function framedMapSet(call: CallExpression): SetSource | undefined {
  const member = unwrapped(call.expression);
  const reflected = globalPathOf(member)?.join('.') === 'Reflect.apply';
  const wrapper =
    (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    (frameMemberName(member) === 'call' || frameMemberName(member) === 'apply');
  const native = reflected || wrapper ? framedNativeArguments(call, SETTERS) : undefined;
  if (native !== undefined && !native.constructed) {
    const receiver = framedArgumentPrefix(call).values[reflected ? 1 : 0];
    if (receiver === undefined) return undefined;
    const args = native.args;
    const prefix = args === undefined ? undefined : framedArgumentPrefix(call, args);
    return setSource(receiver, prefix, true);
  }
  const unresolved =
    native === undefined && wrapper ? framedUnresolvedCall(call, SETTERS) : undefined;
  if (unresolved !== undefined)
    return setSource(unresolved.receiver, framedArgumentPrefix(call, unresolved.args), true);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'set'
  )
    return undefined;
  return setSource(member.expression, framedArgumentPrefix(call), false);
}

/** A complete consumed prefix distinguishes an omitted value from an unresolved argument list. */
function setSource(
  receiver: Expression,
  prefix: ReturnType<typeof framedArgumentPrefix> | undefined,
  borrowed: boolean,
): SetSource {
  return {
    receiver,
    key: prefix?.values[0],
    value: prefix?.values[1],
    borrowed,
    omittedValue:
      prefix !== undefined &&
      !prefix.unknown &&
      prefix.alternatives === undefined &&
      prefix.values.length < 2,
  };
}

/**
 * Written set values supplement entries; only an exact executed native prefix replaces them. A
 * WeakMap keeps its opaque boundary for an unresolved key or a lifecycle that is not quiet, but
 * not where an own method takes part: a get that may answer any entry takes every write, whatever
 * its key, and a set that may be custom is never dropped. Writes the proof cannot follow keep
 * every value they may store, and no data proof.
 */
export function framedMapMutations(
  read: CallExpression,
  selected: MapSource,
  context: MutationContext,
): MapValues | undefined {
  const { key, initial, identity, anyEntry } = context;
  const construction = selected.construction;
  if (construction === undefined || !framedNativeConstructor(construction.expression, MAPS))
    return undefined;
  const chain = framedMapChain(selected, identity);
  if (!chain.possible) return undefined;
  const weak = framedNativeConstructor(construction.expression, WEAKS);
  const wanted = framedMutationKey(key, weak);
  if (weak && wanted === undefined && !anyEntry) return undefined;
  const exact = mapUnexposed(read, selected, identity);
  const writes = possibleWrites({ read, selected, wanted, exact, identity, weak });
  if (weak) {
    const valued = writes.flatMap((write) =>
      write.value === undefined ? [] : [{ call: write.call, value: write.value }],
    );
    if (!weakMapWritesQuiet(read, valued, construction))
      return anyEntry || writes.some((write) => write.custom)
        ? framedUnprovenValues(writes, initial, chain.certain)
        : undefined;
  }
  return framedStoredValues(read, writes, initial, chain.certain);
}

/** Matching writes retain lexical aliases, branches, captured maps and repeated read boundaries. */
function possibleWrites(context: WriteContext): readonly MapWrite[] {
  const { read } = context;
  const writes: MapWrite[] = [];
  const pending: Node[] = [read.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isCallExpression(node)) {
      const write = possibleWrite(node, context);
      if (write !== undefined) writes.push(write);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return writes;
}

/**
 * A possible native write contributes its selected value, keeping uncertain target identities; on
 * a WeakMap too, a set that may be custom still writes, and only a definite one replaces.
 */
function possibleWrite(call: CallExpression, context: WriteContext): MapWrite | undefined {
  const { read, selected, wanted, exact, identity } = context;
  const source = framedMapSet(call);
  if (!mapWrite(source, context.weak)) return undefined;
  const at = identity(source.receiver);
  if (
    at === undefined ||
    at.construction !== selected.construction ||
    !possibleBefore(call, read, selected.bindings) ||
    !framedPossibleBranch(call)
  )
    return undefined;
  const chain = framedMapChain(at, identity);
  const native = source.borrowed
    ? { possible: true, certain: true, open: false }
    : nativeMethod(call, 'set', selected, identity);
  const known = native.open ? undefined : framedMutationKey(source.key, context.weak);
  if (
    !native.possible ||
    !chain.possible ||
    (wanted !== undefined && known !== undefined && wanted !== known)
  )
    return undefined;
  return {
    call,
    value: source.value,
    open: native.open,
    custom: !native.certain,
    unread: source.value === undefined && !source.omittedValue,
    definite:
      exact &&
      chain.certain &&
      native.certain &&
      wanted !== undefined &&
      wanted === known &&
      (selected.sets.includes(call) || definiteBefore(call, read, executionOwner(read))),
  };
}

/**
 * Every set the compile reads writes: one whose value it cannot read, of an argument list it
 * cannot resolve, as an unread write (`MapWrite.unread`), a value of any key where the key is
 * unread too. Native Map omission is a known write; weak values keep their existing explicit-value
 * proof.
 */
function mapWrite(source: SetSource | undefined, weak: boolean): source is SetSource {
  return source !== undefined && !(weak && source.omittedValue);
}

/** Every consumed set link must permit the native same-receiver result. */
export function framedMapChain(
  selected: MapSource,
  identity: MapIdentity,
): { readonly possible: boolean; readonly certain: boolean } {
  let certain = true;
  for (const call of selected.sets) {
    const source = framedMapSet(call);
    if (source === undefined) return { possible: false, certain: false };
    if (source.borrowed) continue;
    const native = nativeMethod(call, 'set', selected, identity);
    if (!native.possible) return native;
    if (!native.certain) certain = false;
  }
  return { possible: true, certain };
}

/**
 * A known custom setter cannot supply native Map identity, while possible overrides keep both. An
 * own method that acts on the Map — through its own `this` or a name for it, put to any use but
 * its returned value — replaces nothing for certain and may store anything (`open`), as may a
 * method the source does not show.
 */
function nativeMethod(
  read: CallExpression,
  method: 'get' | 'set',
  selected: MapSource,
  identity: MapIdentity,
): MethodReach {
  const owner = executionOwner(read);
  const assignments = methodAssignments(read, method, selected, identity);
  let definite: BinaryExpression | undefined;
  for (const assignment of assignments) {
    const { node } = assignment;
    if (
      assignment.exact &&
      definiteBefore(node, read, owner) &&
      (definite === undefined || node.end > definite.end)
    )
      definite = node;
  }
  let possible = definite === undefined;
  let certain = true;
  let open = false;
  const names = (name: Identifier): boolean => namesMap(name, selected, identity);
  for (const { node } of assignments) {
    if (hiddenAssignment(node, definite, owner)) continue;
    const kind = methodKind(node.right, method, names);
    if (kind !== 'own') possible = true;
    if (kind !== 'native') certain = false;
    if (kind === 'open') open = true;
  }
  if (possible || definite === undefined) return { possible, certain: possible && certain, open };
  const source = framedMapSet(read);
  return {
    possible: uncertainMethodUse({
      read,
      definite,
      selected,
      identity,
      method,
      receiver: source?.receiver,
    }),
    certain: false,
    open: false,
  };
}

/**
 * A native install keeps the native call; an own method replaces it unless it acts on the Map. One
 * the source does not show as a written function may do anything, as an acting one may.
 */
function methodKind(
  value: Expression,
  method: 'get' | 'set',
  names: (name: Identifier) => boolean,
): 'native' | 'open' | 'own' {
  if (framedNativeConstructor(value, method === 'set' ? SETTERS : GETTERS)) return 'native';
  return framedOwnMethod(value) && !framedReceiverDispatch(value, names) ? 'own' : 'open';
}

/** A read of a name for the selected Map, as an own method's closure may make. */
function namesMap(name: Identifier, selected: MapSource, identity: MapIdentity): boolean {
  const source = bindingRead(name) ? identity(name) : undefined;
  return source !== undefined && source.construction === selected.construction;
}

/** Intervening unmodeled collection uses lose a custom method's exact replacement proof. */
function uncertainMethodUse(context: MethodUse): boolean {
  const { read, selected, identity } = context;
  const pending: Node[] = [read.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isIdentifier(node) &&
      bindingRead(node) &&
      identity(node)?.construction === selected.construction &&
      possibleBefore(node, read, selected.bindings) &&
      framedPossibleBranch(node) &&
      !unchangingMethodUse(node, context)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** A current receiver, immutable alias or already modeled assignment changes no unseen method. */
function unchangingMethodUse(node: Identifier, context: MethodUse): boolean {
  const { definite, read, identity, selected, method, receiver } = context;
  if (node.pos >= definite.pos && node.end <= definite.end) return true;
  if (executionOwner(node) === executionOwner(read) && node.pos < definite.end) return true;
  if (initializedAfterRead(node, read)) return true;
  if (receiver !== undefined && unwrapped(receiver) === node) return true;
  const { parent } = useOf(node);
  if (
    isVariableDeclaration(parent) &&
    parent.initializer !== undefined &&
    unwrapped(parent.initializer) === node &&
    isIdentifier(parent.name)
  )
    return identity(parent.name)?.construction === selected.construction;
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    frameMemberName(parent) !== method
  )
    return false;
  const use = useOf(parent);
  return (
    isBinaryExpression(use.parent) &&
    use.parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    use.parent.left === use.at
  );
}

/** A later local alias cannot change the method while its own initializer is still running. */
function initializedAfterRead(node: Identifier, read: CallExpression): boolean {
  const selected = frameBindingOf(node);
  const binding = selected?.binding;
  if (binding === undefined || !isVariableDeclaration(binding) || binding.initializer === undefined)
    return false;
  const owner = executionOwner(read);
  return (
    executionOwner(binding) === owner &&
    binding.initializer.pos <= read.pos &&
    binding.initializer.end >= read.end &&
    !repeatedFrameRead(node, read, binding, owner)
  );
}

/** A later certain same-owner assignment supersedes only its earlier own assignments. */
function hiddenAssignment(
  node: BinaryExpression,
  definite: BinaryExpression | undefined,
  owner: Node,
): boolean {
  return (
    definite !== undefined &&
    node !== definite &&
    node.end <= definite.end &&
    executionOwner(node) === owner
  );
}

/** Own assignments use the receiver's original constructor identity rather than a repeated name. */
function methodAssignments(
  read: CallExpression,
  method: string,
  selected: MapSource,
  identity: MapIdentity,
): readonly MethodAssignment[] {
  const found: MethodAssignment[] = [];
  const pending: Node[] = [read.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isBinaryExpression(node) &&
      node.operatorToken.kind === SyntaxKind.EqualsToken &&
      possibleBefore(node, read, selected.bindings) &&
      framedPossibleBranch(node)
    ) {
      const target = methodTarget(node.left, method, selected, identity);
      if (target !== undefined) found.push({ node, exact: certainIdentity(target, identity) });
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found;
}

/** Only a member of the same written Map construction supplies its own method assignment. */
function methodTarget(
  node: Expression,
  method: string,
  selected: MapSource,
  identity: MapIdentity,
): MapSource | undefined {
  const member = unwrapped(node);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== method
  )
    return undefined;
  const target = identity(member.expression);
  return target?.construction === selected.construction ? target : undefined;
}

/** A fresh direct chain or a whole constant alias has a definite constructor identity. */
function certainIdentity(selected: MapSource, identity: MapIdentity): boolean {
  return selected.sets.every((call) => {
    const source = framedMapSet(call);
    return (
      source !== undefined && (source.borrowed || identity(source.receiver)?.bindings.size === 0)
    );
  });
}

/** An exact replacement requires a fresh local Map with no unmodeled earlier or captured uses. */
function mapUnexposed(read: CallExpression, selected: MapSource, identity: MapIdentity): boolean {
  const construction = selected.construction;
  if (construction === undefined || executionOwner(construction) !== executionOwner(read))
    return false;
  const pending: Node[] = [read.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isIdentifier(node) &&
      bindingRead(node) &&
      identity(node)?.construction === construction &&
      possibleBefore(node, read, selected.bindings) &&
      framedPossibleBranch(node) &&
      !modeledUse(node, read, selected, identity)
    )
      return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** A declaration's own identifier does not expose the initialized collection. */
function bindingRead(node: Identifier): boolean {
  const selected = frameBindingOf(node);
  return selected !== undefined && node !== selected.binding.name && readsBinding(node);
}

/** Whole aliases and source-known native calls preserve the bounded collection state. */
function modeledUse(
  node: Expression,
  read: CallExpression,
  selected: MapSource,
  identity: MapIdentity,
): boolean {
  const { parent } = useOf(node);
  if (
    isVariableDeclaration(parent) &&
    parent.initializer !== undefined &&
    unwrapped(parent.initializer) === unwrapped(node) &&
    isIdentifier(parent.name)
  )
    return identity(parent.name)?.construction === selected.construction;
  if (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) {
    const name = frameMemberName(parent);
    if (name !== 'set' && name !== 'get') return false;
    const use = useOf(parent);
    if (
      isBinaryExpression(use.parent) &&
      use.parent.operatorToken.kind === SyntaxKind.EqualsToken &&
      use.parent.left === use.at
    )
      return true;
    return (
      isCallExpression(use.parent) &&
      unwrapped(use.parent.expression) === parent &&
      (use.parent === read || nativeMethod(use.parent, name, selected, identity).certain)
    );
  }
  const source = isCallExpression(parent) ? framedMapSet(parent) : undefined;
  return source !== undefined && unwrapped(source.receiver) === unwrapped(node);
}

/** The same lexical owner and source-proven selected if arms establish an executed prefix. */
function definiteBefore(node: Node, read: Node, owner: Node): boolean {
  if (executionOwner(node) !== owner || node.end > read.pos || !isExpressionStatement(node.parent))
    return false;
  let within: Node = node.parent;
  for (;;) {
    const parent = within.parent;
    if (parent === owner) return true;
    if (isBlock(parent)) {
      within = parent;
      continue;
    }
    if (!isIfStatement(parent)) return false;
    const condition = framedCondition(parent.expression);
    if (condition === undefined) return false;
    const chosen: Node | undefined = condition ? parent.thenStatement : parent.elseStatement;
    if (within !== chosen) return false;
    within = parent;
  }
}

/** Later same-owner writes matter only for a repeated read or a map captured between calls. */
function possibleBefore(node: Node, read: Node, bindings: ReadonlySet<FrameBinding>): boolean {
  const owner = executionOwner(read);
  const writer = executionOwner(node);
  if (writer !== owner) return !unreferencedLocalFunction(writer, owner);
  if (
    node.pos < read.pos ||
    (node.pos >= read.pos && node.end <= read.end) ||
    destructuredFirst(node, read)
  )
    return true;
  for (const binding of bindings)
    if (repeatedFrameRead(node, read, binding, owner) || executionOwner(binding) !== owner)
      return true;
  return false;
}
