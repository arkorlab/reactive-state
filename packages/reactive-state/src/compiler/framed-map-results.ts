import {
  type CallExpression,
  type BinaryExpression,
  type Expression,
  type Identifier,
  type NewExpression,
  type TypeNode,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isExpressionStatement,
  isIfStatement,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { framedAtMethod, framedReceiverDispatch } from './framed-at-methods.ts';
import {
  frameBindingOf,
  frameMemberName,
  frameTypeOf,
  type FrameBinding,
} from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedLiteralObject } from './framed-literal-data.ts';
import { framedMapChainValues } from './framed-map-chain-values.ts';
import { framedMapChain, framedMapMutations, framedMapSet } from './framed-map-mutations.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedCondition, framedNativeConstructor } from './framed-sources.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { namesLocalMemberType, namesLocalTypeArgument } from './local-type-reading.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

const MAP_TYPES = new Set(['Map', 'ReadonlyMap', 'WeakMap']);
const MAP_CONSTRUCTORS = new Set(['Map', 'WeakMap']);
const NATIVE_GETTERS = new Set(['Map.prototype.get', 'WeakMap.prototype.get']);

interface MapReading {
  readonly construction: NewExpression | undefined;
  readonly bindings: ReadonlySet<FrameBinding>;
  readonly type: TypeNode | undefined;
  readonly sets: readonly CallExpression[];
}

interface MapValueReading {
  readonly values: readonly Expression[] | undefined;
  readonly complete: boolean;
  readonly sameReceiver: boolean;
  /** Whether a possible write stores a value the compile cannot read. */
  readonly unread: boolean;
}

/**
 * An own get's possible result, whether it may answer any entry by acting on the Map, and whether
 * one's result is unread: a body the compile cannot read, or a method the source does not show.
 */
interface OwnReading {
  readonly result: boolean | undefined;
  readonly entries: boolean;
  readonly unread: boolean;
}

/** How an installed get answers; see `getterAnswer`. */
type GetterAnswer = 'closed' | 'entries' | 'error' | 'native' | 'unread';

/**
 * Native get results retain a selected entry or a directly written native Map value type; an own
 * get that acts on the Map may answer any entry, whatever the key, and an unread one leaves no
 * data proof.
 */
export function framedMapResult(
  call: CallExpression,
  made: boolean,
  names: ReadonlySet<string>,
  error: (value: Expression, local: boolean) => boolean,
): boolean | undefined {
  const selection = mapGetSelection(call);
  if (selection === undefined) return undefined;
  const selected = nativeMap(selection.receiver);
  if (selected === undefined) return undefined;
  const own: OwnReading = selection.borrowed
    ? { result: undefined, entries: false, unread: false }
    : ownResult(call, selected.bindings, (value) => error(value, made));
  const reading = mapValues(call, selected, own.entries ? undefined : selection.key, own.entries);
  if (reading === undefined) return undefined;
  if (own.result === true || (own.result === false && reading.sameReceiver)) return own.result;
  const { values } = reading;
  if (values?.some((value) => error(value, made)) === true) return true;
  const proven = !made && !own.unread && reading.complete;
  if (proven && knownData(values, (value) => error(value, true))) return false;
  return declaredMapError(selected, reading.unread, names);
}

/**
 * What the Map's declared value type says of what it holds: an Error where it names one. A value
 * the compile cannot read (`unread`) is read by that type alone, and as any value with none.
 */
function declaredMapError(
  selected: MapReading,
  unread: boolean,
  names: ReadonlySet<string>,
): boolean | undefined {
  const explicit = selected.construction?.typeArguments?.[1];
  if (explicit !== undefined && namesLocalMemberType(explicit, [], names)) return true;
  if (typedMapError(selected.type, names)) return true;
  return unread && explicit === undefined && selected.type === undefined ? true : undefined;
}

/**
 * A source-known set chain retains possible stored values before native type fallbacks; a get that
 * may answer any entry (`anyEntry`) reads every write, whatever its key, on a WeakMap too.
 */
function mapValues(
  call: CallExpression,
  selected: MapReading,
  key: Expression | undefined,
  anyEntry: boolean,
): MapValueReading | undefined {
  const entries = selected.construction?.arguments?.[0];
  const initial = entries === undefined ? undefined : selectedValues(entries, key);
  const context = { key, initial, identity: nativeMap, anyEntry };
  const mutation = framedMapMutations(call, selected, context);
  if (mutation === undefined && selected.sets.length > 0) {
    if (selected.construction !== undefined) return undefined;
    const chain = framedMapChain(selected, nativeMap);
    return chain.possible
      ? {
          values: framedMapChainValues(call, selected.sets),
          complete: false,
          sameReceiver: chain.certain,
          unread: false,
        }
      : undefined;
  }
  return {
    values: mutation?.values ?? initial,
    complete: mutation === undefined || mutation.complete,
    sameReceiver: mutation?.sameReceiver ?? true,
    unread: mutation?.unread === true,
  };
}

/** Only wholly known data or locally constructed Error words establish a data result. */
function knownData(
  values: readonly Expression[] | undefined,
  local: (value: Expression) => boolean,
): boolean {
  return (
    values !== undefined &&
    values.length > 0 &&
    values.every((value) => framedLiteralObject(value) || local(value))
  );
}

interface MapSelection {
  readonly receiver: Expression;
  readonly key: Expression | undefined;
  readonly borrowed: boolean;
}

/** Explicit native borrowing bypasses instance own methods and retains its actual receiver and key. */
function mapGetSelection(call: CallExpression): MapSelection | undefined {
  const member = unwrapped(call.expression);
  const reflected = globalPathOf(member)?.join('.') === 'Reflect.apply';
  const wrapper =
    (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    (frameMemberName(member) === 'call' || frameMemberName(member) === 'apply');
  const native = reflected || wrapper ? framedNativeArguments(call, NATIVE_GETTERS) : undefined;
  if (native !== undefined && !native.constructed) {
    const prefix = framedArgumentPrefix(call, call.arguments);
    const receiver = prefix.values[reflected ? 1 : 0];
    if (receiver === undefined) return undefined;
    const args = native.args;
    const key = args === undefined ? undefined : framedArgumentPrefix(call, args, 1).values[0];
    return { receiver, key, borrowed: true };
  }
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'get'
  )
    return undefined;
  const prefix = framedArgumentPrefix(call, call.arguments, 1);
  const key = prefix.unknown || prefix.alternatives !== undefined ? undefined : prefix.values[0];
  return { receiver: member.expression, key, borrowed: false };
}

/** Native constructions and lexical whole aliases retain source identity without class inventories. */
function nativeMap(node: Expression): MapReading | undefined {
  let value = unwrapped(node);
  const bindings = new Set<FrameBinding>();
  const sets: CallExpression[] = [];
  const seen = new Set<Node>();
  let type: TypeNode | undefined;
  for (;;) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const set = mapSetLink(value);
    if (set !== undefined) {
      sets.push(set.call);
      value = unwrapped(set.receiver);
      continue;
    }
    if (!isIdentifier(value)) break;
    const binding = mapBinding(value, bindings);
    if (binding === undefined) return undefined;
    bindings.add(binding);
    type ??= binding.type;
    const initializer = mapInitializer(binding);
    if (initializer === undefined) break;
    value = unwrapped(initializer);
  }
  if (isNewExpression(value) && framedNativeConstructor(value.expression, MAP_CONSTRUCTORS))
    return { construction: value, bindings, type, sets };
  type ??= frameTypeOf(node)?.type;
  return type !== undefined && namesLocalMemberType(type, [], MAP_TYPES)
    ? { construction: undefined, bindings, type, sets }
    : undefined;
}

/** A written set call carries its explicit receiver while the chain keeps the original call node. */
function mapSetLink(
  value: Expression,
): { readonly call: CallExpression; readonly receiver: Expression } | undefined {
  if (!isCallExpression(value)) return undefined;
  const source = framedMapSet(value);
  return source === undefined ? undefined : { call: value, receiver: source.receiver };
}

/** Whole lexical aliases retain their own binding and stop repeated declaration cycles. */
function mapBinding(
  name: Identifier,
  bindings: ReadonlySet<FrameBinding>,
): FrameBinding | undefined {
  const selected = frameBindingOf(name);
  return selected === undefined || selected.keys.length > 0 || bindings.has(selected.binding)
    ? undefined
    : selected.binding;
}

/** Only a whole const declaration carries its native Map initializer into an alias read. */
function mapInitializer(binding: FrameBinding): Expression | undefined {
  return isVariableDeclaration(binding) &&
    isVariableDeclarationList(binding.parent) &&
    /^const\s/u.test(binding.parent.getText(binding.getSourceFile()))
    ? binding.initializer
    : undefined;
}

/** Exact written entry keys select the last matching value; unknown keys retain all entry values. */
function selectedValues(
  node: Expression,
  key: Expression | undefined,
): readonly Expression[] | undefined {
  const value = unwrapped(node);
  if (!isArrayLiteralExpression(value)) return undefined;
  const wanted = key === undefined ? undefined : constantValue(unwrapped(key));
  const values: Expression[] = [];
  let exact = wanted !== undefined;
  let selected: Expression | undefined;
  for (const element of value.elements) {
    if (isOmittedExpression(element) || isSpreadElement(element)) return undefined;
    const entry = unwrapped(element);
    if (!isArrayLiteralExpression(entry) || entry.elements.some((each) => isSpreadElement(each)))
      return undefined;
    const [entryKey, entryValue] = entry.elements;
    if (
      entryKey === undefined ||
      entryValue === undefined ||
      isOmittedExpression(entryKey) ||
      isOmittedExpression(entryValue)
    )
      return undefined;
    values.push(entryValue);
    const known = constantValue(unwrapped(entryKey));
    if (known === undefined) exact = false;
    else if (known === wanted || Object.is(known, wanted)) selected = entryValue;
  }
  if (!exact) return values;
  return selected === undefined ? [] : [selected];
}

/** Written native generic arguments preserve Error value types without inspecting class members. */
function typedMapError(type: TypeNode | undefined, names: ReadonlySet<string>): boolean {
  return namesLocalTypeArgument(type, MAP_TYPES, 1, names);
}

/**
 * Possible own results supplement the native result unless a definite prefix replaces the method.
 * An own get that acts on the Map — through its own `this` or a name for it, put to any use but its
 * returned value — replaces nothing for certain, and its reads may answer any entry. One whose
 * result is unread, a body the compile cannot read or a method the source does not show, may
 * answer anything, any entry among it. The native get installed again reads the selected key.
 */
function ownResult(
  call: CallExpression,
  bindings: ReadonlySet<FrameBinding>,
  error: (value: Expression) => boolean,
): OwnReading {
  const owner = executionOwner(call);
  const assignments = ownGetters(call, bindings);
  let definite: BinaryExpression | undefined;
  for (const node of assignments)
    if (definiteBefore(node, call, owner) && (definite === undefined || node.pos > definite.pos))
      definite = node;
  const answers = new Set<GetterAnswer>();
  for (const node of assignments) {
    if (hiddenGetter(node, definite, owner)) continue;
    const answer = getterAnswer(node.right, bindings, error);
    if (answer === 'error') return { result: true, entries: false, unread: false };
    answers.add(answer);
  }
  const unread = answers.has('unread');
  const entries = unread || answers.has('entries');
  const closed = definite !== undefined && !answers.has('native') && !entries;
  return { result: closed ? false : undefined, entries, unread };
}

/**
 * How an installed get answers: as the native get, which reads the selected key; with a possible
 * error; unread, a body the compile cannot read or a method the source does not show; through the
 * Map it acts on (`entries`); or with its own closed result.
 */
function getterAnswer(
  value: Expression,
  bindings: ReadonlySet<FrameBinding>,
  error: (value: Expression) => boolean,
): GetterAnswer {
  if (framedNativeConstructor(value, NATIVE_GETTERS)) return 'native';
  const result = framedAtMethod(value, error);
  if (result === true) return 'error';
  if (result === undefined) return 'unread';
  return framedReceiverDispatch(value, (name) => namesMap(name, bindings)) ? 'entries' : 'closed';
}

/** A later definite same-owner get assignment supersedes only its earlier own assignments. */
function hiddenGetter(
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

/** A read of a whole binding of the selected Map, as an own method's closure may make. */
function namesMap(name: Identifier, bindings: ReadonlySet<FrameBinding>): boolean {
  const selected = frameBindingOf(name);
  return (
    selected?.keys.length === 0 &&
    name !== selected.binding.name &&
    bindings.has(selected.binding) &&
    readsBinding(name)
  );
}

/** All possible lexical get assignments retain their original execution and branch context. */
function ownGetters(
  call: CallExpression,
  bindings: ReadonlySet<FrameBinding>,
): readonly BinaryExpression[] {
  if (bindings.size === 0) return [];
  const owner = executionOwner(call);
  const found: BinaryExpression[] = [];
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isBinaryExpression(node) &&
      node.operatorToken.kind === SyntaxKind.EqualsToken &&
      getterTarget(node.left, bindings) &&
      possibleBefore(node, call, owner, bindings) &&
      framedPossibleBranch(node)
    )
      found.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found;
}

/** A standalone prefix and source-proven selected if arms establish an executed replacement. */
function definiteBefore(node: BinaryExpression, read: Node, owner: Node): boolean {
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
    const selected: Node | undefined = condition ? parent.thenStatement : parent.elseStatement;
    if (within !== selected) return false;
    within = parent;
  }
}

/** The same lexical receiver identity, excluding destructured fields and unrelated names. */
function getterTarget(node: Expression, bindings: ReadonlySet<FrameBinding>): boolean {
  const value = unwrapped(node);
  if (
    (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) ||
    frameMemberName(value) !== 'get'
  )
    return false;
  const receiver = unwrapped(value.expression);
  if (!isIdentifier(receiver)) return false;
  const selected = frameBindingOf(receiver);
  return selected?.keys.length === 0 && bindings.has(selected.binding);
}

/** Same-owner prefixes and repeated reads preserve the existing conservative execution boundary. */
function possibleBefore(
  node: Node,
  read: Node,
  owner: Node,
  bindings: ReadonlySet<FrameBinding>,
): boolean {
  const writer = executionOwner(node);
  if (writer !== owner) return !unreferencedLocalFunction(writer, owner);
  if (node.pos < read.pos || destructuredFirst(node, read)) return true;
  for (const binding of bindings)
    if (repeatedFrameRead(node, read, binding, owner) || executionOwner(binding) !== owner)
      return true;
  return false;
}
