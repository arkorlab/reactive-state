import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isIfStatement,
  isMethodDeclaration,
  isNewExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type MethodDeclaration,
  type NewExpression,
  type Node,
  SyntaxKind,
  type TypeNode,
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
import {
  framedInstalledMethods,
  framedMutatorsInstalled,
  framedReceiverInstalled,
  type InstalledMethod,
} from './framed-collection-prototypes.ts';
import { framedDeclaredAdmitted } from './framed-declared-collections.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedMethodsWritten } from './framed-iteration-writes.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedLiteralObject } from './framed-literal-data.ts';
import { framedMapChainValues } from './framed-map-chain-values.ts';
import {
  framedMapChain,
  framedMapChainSets,
  framedMapMutations,
  framedMapSet,
} from './framed-map-mutations.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedQuietSource } from './framed-native-evaluation.ts';
import { framedCondition, framedNativeConstructor } from './framed-sources.ts';
import { framedUnreadInput } from './framed-unread-inputs.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { namesLocalMemberType, namesLocalTypeArgument } from './local-type-reading.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

const MAP_TYPES = new Set(['Map', 'ReadonlyMap', 'WeakMap']);
const MAP_CONSTRUCTORS = new Set(['Map', 'WeakMap']);
const NATIVE_GETTERS = new Set(['Map.prototype.get', 'WeakMap.prototype.get']);
const WEAK_MAPS = new Set(['WeakMap']);
/** The native collections a get may be any of. */
const MAP_KINDS: readonly string[] = ['Map', 'WeakMap'];

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
 * get that acts on the Map may answer any entry, whatever the key. Where a replacement the reader
 * cannot read may answer or store instead (`unseenChange`), or a set chain may answer another
 * receiver than the Map (`elsewhereResult`), any entry may answer and no data proof stands, and the
 * get may answer an Error wherever the declared value type admits one.
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
  if (!framedMapChain(selected, nativeMap).certain)
    return elsewhereResult(call, selection, selected, {
      names,
      error: (value) => error(value, made),
    });
  const own = ownResult(
    call,
    selection.borrowed ? new Set<FrameBinding>() : selected.bindings,
    (value) => error(value, made),
    installedGetters(call, mapKinds(selected)),
  );
  if (own.result === true) return true;
  const change = unseenChange(call, selected, own.result === false);
  const unseen = own.unread || change !== undefined;
  const anyEntry = own.entries || unseen;
  const reading = mapValues(call, selected, anyEntry ? undefined : selection.key, anyEntry);
  // A definite own get answers itself where only what the Map holds may have changed.
  if (change !== 'getter' && own.result === false && reading?.sameReceiver === true) return false;
  if (unseen)
    return unseenResult(reading, selected, { names, error: (value) => error(value, made) });
  if (reading === undefined) return undefined;
  const { values } = reading;
  if (values?.some((value) => error(value, made)) === true) return true;
  const proven = !made && reading.complete;
  if (proven && knownData(values, (value) => error(value, true))) return false;
  return declaredError(selected, reading.unread, names);
}

/**
 * What a get answers through a set chain that may answer another receiver than the Map
 * (`framedMapChain`): an Error any collection's installed get may answer, or the Map's own get
 * where the chain may answer the Map itself, which only a set answering a collection of its own
 * making rules out (`freshChain`); else what a replacement the reader cannot read leaves
 * (`unseenResult`): the declared value type, or anything.
 */
function elsewhereResult(
  call: CallExpression,
  selection: MapSelection,
  selected: MapReading,
  context: {
    readonly names: ReadonlySet<string>;
    readonly error: (value: Expression) => boolean;
  },
): boolean | undefined {
  const own = !selection.borrowed && !freshChain(selected);
  const readings = [
    ownResult(call, new Set<FrameBinding>(), context.error, installedGetters(call, MAP_KINDS)),
    ...(own ? [ownResult(call, selected.bindings, context.error, [])] : []),
  ];
  if (readings.some((reading) => reading.result === true)) return true;
  return unseenResult(mapValues(call, selected, undefined, true), selected, context);
}

/**
 * Whether a set chain surely answers a native Map or WeakMap its set makes itself: each own set it
 * runs instead of the native one (`framedMapChainSets`) returns such a construction directly
 * (`framedAtMethod`), which holds none of the Map's own methods. One that may return anything else,
 * its receiver among it, does not.
 */
function freshChain(selected: MapReading): boolean {
  const sets = framedMapChainSets(selected, nativeMap);
  return (
    sets.length > 0 &&
    sets.every((value) => framedAtMethod(value, (returned) => !freshMap(returned)) === false)
  );
}

/** A native Map or WeakMap constructed in place. */
function freshMap(value: Expression): boolean {
  const actual = unwrapped(value);
  return isNewExpression(actual) && framedNativeConstructor(actual.expression, MAP_CONSTRUCTORS);
}

/**
 * What a get a replacement the reader cannot read may answer instead (`unseenChange`)
 * answers: an Error a value it may still answer holds, and one wherever the declared value type
 * admits one (`unseenAdmits`), else what the declared type says (`declaredError`); never data.
 */
function unseenResult(
  reading: MapValueReading | undefined,
  selected: MapReading,
  context: {
    readonly names: ReadonlySet<string>;
    readonly error: (value: Expression) => boolean;
  },
): boolean | undefined {
  if (reading?.values?.some((value) => context.error(value)) === true) return true;
  return unseenAdmits(selected)
    ? true
    : declaredError(selected, reading?.unread === true, context.names);
}

/**
 * The scope `unseenChange` reads writes of the get itself in, on the Map; what a plain own get or
 * set does with the Map, the reader reads with it.
 */
const GETTER_SCOPE = {
  members: new Set(['__proto__', 'get']),
  attributed: new Set(['get', 'set']),
};
/** The scope `unseenChange` reads writes of a mutator in, on the Map. */
const MUTATOR_SCOPE = {
  members: new Set(['clear', 'delete', 'set']),
  attributed: new Set(['set']),
};

/**
 * What a replacement the reader cannot read may change. `'getter'`, the get itself: a write of it
 * or of the Map's prototype on the Map, or a use that hands the Map on (`framedMethodsWritten`);
 * for a definite own get, also a prototype method that may write the Map's own members when
 * called on it (`framedReceiverInstalled`). `'contents'`, what the Map holds alone: a mutator the
 * prototype may be given (`framedMutatorsInstalled`) or the Map's own replaced unseen, a plain own
 * set, which the reader reads itself, excepted. When in doubt, the getter.
 */
function unseenChange(
  call: CallExpression,
  selected: MapReading,
  definite: boolean,
): 'contents' | 'getter' | undefined {
  const file = call.getSourceFile();
  const kinds = mapKinds(selected);
  if (framedMethodsWritten(selected.bindings, call, GETTER_SCOPE)) return 'getter';
  if (definite && kinds.some((kind) => framedReceiverInstalled(file, kind))) return 'getter';
  if (kinds.some((kind) => framedMutatorsInstalled(file, kind))) return 'contents';
  return framedMethodsWritten(selected.bindings, call, MUTATOR_SCOPE) ? 'contents' : undefined;
}

/**
 * Whether the Map's declared value type admits an Error, as one none is declared for does: its
 * construction's own argument, else the value argument of the annotation of the name it is read
 * through, past local aliases (`framedDeclaredAdmitted`).
 */
function unseenAdmits(selected: MapReading): boolean {
  const written = selected.construction?.typeArguments;
  return framedDeclaredAdmitted({ written, annotation: selected.type }, 'Map', 1);
}

/**
 * What a Map's declared value type says where no written value answers: a construction given an
 * input the compile cannot read (`unreadEntries`), or a write of a value it cannot read
 * (`unread`), may hold an Error where that type admits one (`unseenAdmits`), as any value where
 * none is declared; and a written native value type that names one does.
 */
function declaredError(
  selected: MapReading,
  unread: boolean,
  names: ReadonlySet<string>,
): boolean | undefined {
  if (unreadEntries(selected) || (unread && unseenAdmits(selected))) return true;
  const explicit = selected.construction?.typeArguments?.[1];
  if (explicit !== undefined && namesLocalMemberType(explicit, [], names)) return true;
  return typedMapError(selected.type, names) ? true : undefined;
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

/**
 * A written construction given an input the compile cannot read (`framedUnreadInput`) may hold an
 * Error where its declared value type admits one (`unseenAdmits`).
 */
function unreadEntries(selected: MapReading): boolean {
  const input = selected.construction?.arguments?.[0];
  return input !== undefined && framedUnreadInput(input, true) && unseenAdmits(selected);
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
  const native =
    reflected || wrapper ? framedNativeArguments(call, NATIVE_GETTERS, true) : undefined;
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

/**
 * Exact written entry keys select the last matching value; unknown keys retain all entry values.
 * The entries are read past a quiet comma and through unexposed whole `const` aliases
 * (`framedQuietSource`).
 */
function selectedValues(
  node: Expression,
  key: Expression | undefined,
): readonly Expression[] | undefined {
  const value = framedQuietSource(node);
  if (value === undefined || !isArrayLiteralExpression(value)) return undefined;
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
  inherited: readonly InstalledMethod[],
): OwnReading {
  const owner = executionOwner(call);
  const assignments = ownGetters(call, bindings);
  let definite: BinaryExpression | undefined;
  for (const node of assignments)
    if (definiteBefore(node, call, owner) && (definite === undefined || node.pos > definite.pos))
      definite = node;
  // A definite own get answers itself, whatever the prototype holds.
  const installed = [
    ...assignments.filter((node) => !hiddenGetter(node, definite, owner)).map((node) => node.right),
    ...(definite === undefined ? inherited : []),
  ];
  const answers = new Set<GetterAnswer>();
  for (const value of installed) {
    const answer = value === undefined ? 'unread' : getterAnswer(value, bindings, error);
    if (answer === 'error') return { result: true, entries: false, unread: false };
    answers.add(answer);
  }
  const unread = answers.has('unread');
  const entries = unread || answers.has('entries');
  const closed = definite !== undefined && !answers.has('native') && !entries;
  return { result: closed ? false : undefined, entries, unread };
}

/**
 * What the file may install as the get the prototype of each of the collection kinds holds
 * (`framedInstalledMethods`).
 */
function installedGetters(
  call: CallExpression,
  kinds: readonly string[],
): readonly InstalledMethod[] {
  const file = call.getSourceFile();
  return kinds.flatMap((kind) => framedInstalledMethods(file, kind, 'get'));
}

/** The native collections a Map reading may be: its construction's, or either for a type alone. */
function mapKinds(selected: MapReading): readonly string[] {
  const { construction } = selected;
  if (construction === undefined) return MAP_KINDS;
  return [framedNativeConstructor(construction.expression, WEAK_MAPS) ? 'WeakMap' : 'Map'];
}

/**
 * How an installed get answers: as the native get, which reads the selected key; with a possible
 * error; unread, a body the compile cannot read or a method the source does not show; through the
 * Map it acts on (`entries`); or with its own closed result.
 */
function getterAnswer(
  value: Expression | MethodDeclaration,
  bindings: ReadonlySet<FrameBinding>,
  error: (value: Expression) => boolean,
): GetterAnswer {
  if (!isMethodDeclaration(value) && framedNativeConstructor(value, NATIVE_GETTERS))
    return 'native';
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
