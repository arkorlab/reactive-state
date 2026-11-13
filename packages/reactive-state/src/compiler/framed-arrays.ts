import {
  type Expression,
  type ArrayLiteralExpression,
  type CallExpression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isDeleteExpression,
  isExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSourceFile,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import {
  mayRunAgain,
  overwrittenInPass,
  recursesBetween,
  selectedMethod,
  type SelectedMethod,
  writtenAfterRead,
  writtenAfterSelection,
} from './framed-array-call-order.ts';
import { callMethodWrites } from './framed-array-call-writes.ts';
import { arrayWritesUnfollowed, writtenArrayElements } from './framed-array-elements.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { arrayIdentity, mayBeArray } from './framed-array-identity.ts';
import { executionOwner } from './framed-array-mutations.ts';
import {
  type ArrayMethodOverride,
  forgetMethods,
  OWN_METHODS,
  afterAssignment,
  afterPossibleWrite,
  afterSureWrite,
  definiteExpression,
  evaluatedForSure,
  inRunOrder,
  type OwnMethods,
  ownMethodAssignment,
} from './framed-array-own-methods.ts';
import { defaultArrayComparison } from './framed-array-sorting.ts';
import { writtenArrayWords } from './framed-array-word-origins.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { afterDeletion, deletedFrom, deletedReceiver } from './framed-deleted-methods.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedKeyNames } from './framed-keys.ts';
import { mutatorInvocation, PATHS } from './framed-mutator-calls.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { framedPossibleBranch } from './framed-writes.ts';
import { framedWrittenTargets } from './framed-written-targets.ts';

/** Native array text conversion observes the error words its selected elements carry. */

interface ArrayWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** Whether a native join or toString call converts an explicitly written error element to text. */
export function framedArrayText(node: Node, words: ArrayWords): boolean {
  if (!isCallExpression(node)) return false;
  const borrowed = borrowedTextCall(node);
  if (borrowed?.path.slice(0, -1).join('.') === 'Array.prototype')
    return borrowedArrayText(borrowed, words, node);
  const member = unwrapped(node.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return false;
  const method = frameMemberName(member);
  const receiver = unwrapped(member.expression);
  if (method === 'sort' || method === 'toSorted')
    return (
      !arrayMethodOverridden(receiver, method, node) &&
      !sourceArrayFunction(member) &&
      defaultArrayComparison(receiver, node, node.arguments) &&
      arrayError(receiver, words, node)
    );
  if (method !== 'join' && method !== 'toString') return false;
  if (arrayMethodOverridden(receiver, method, node) || sourceArrayFunction(member)) return false;
  return (
    arrayError(receiver, words, node) ||
    (method === 'join' && separatorWords(node.arguments, words, node))
  );
}

/** Positive literal origins retain locally written words before falling back to an annotation. */
export function framedArrayWrittenWords(
  value: Expression,
  created: (value: Expression) => boolean,
): boolean {
  return writtenArrayWords(value, {
    created,
    custom: (each) => arrayMethodOverridden(each, 'toString', value),
  });
}

/** Native String conversion uses the array's selected text method before reading nested elements. */
export function framedArrayString(
  value: Expression | undefined,
  words: ArrayWords,
  call: Node,
): boolean {
  return (
    value !== undefined &&
    !arrayMethodOverridden(unwrapped(value), 'toString', call) &&
    arrayError(value, words, call)
  );
}

/** Borrowed native methods retain their receiver and the explicit join separator. */
function borrowedArrayText(
  borrowed: NonNullable<ReturnType<typeof borrowedTextCall>>,
  words: ArrayWords,
  node: CallExpression,
): boolean {
  const method = borrowed.path.at(-1);
  if (method === 'sort' || method === 'toSorted')
    return (
      defaultArrayComparison(borrowed.receiver, node, borrowed.given, borrowed.applied) &&
      arrayError(borrowed.receiver, words, node)
    );
  if (method !== 'join' && method !== 'toString') return false;
  if (method === 'toString' && arrayMethodOverridden(borrowed.receiver, 'join', node)) return false;
  return (
    arrayError(borrowed.receiver, words, node) ||
    (method === 'join' &&
      (separatorWords(borrowed.given, words, node) ||
        (borrowed.applied !== undefined && appliedSeparator(borrowed.applied, words, node))))
  );
}

/**
 * A native join converts its first separator value as String does, an array through its own text
 * methods first; later arguments do not participate.
 */
function separatorWords(
  args: readonly Expression[],
  words: ArrayWords,
  call: CallExpression,
): boolean {
  return framedConsumedArguments(call, args, 1).some((value) => {
    return isSpreadElement(value)
      ? arrayError(value.expression, words, call)
      : words.error(value) || framedArrayString(value, words, call);
  });
}

/** Literal apply lists retain the separator slot; opaque lists may supply an error there. */
function appliedSeparator(
  expression: Expression,
  words: ArrayWords,
  call: CallExpression,
): boolean {
  const value = unwrapped(expression);
  return isArrayLiteralExpression(value)
    ? separatorWords(value.elements, words, call)
    : arrayError(value, words, call);
}

/** Literal arrays, their lexical aliases, and explicitly array-typed inputs retain element words. */
export function arrayError(value: Expression, words: ArrayWords, call: Node): boolean {
  const pending: ArrayReading[] = [{ value, text: false }];
  const seen = new Set<FrameBinding>();
  for (let reading = pending.pop(); reading !== undefined; reading = pending.pop()) {
    const each = unwrapped(reading.value);
    if (reading.text && arrayMethodOverridden(each, 'toString', call)) continue;
    if (isArrayLiteralExpression(each)) {
      if (literalErrors(each, words, pending)) return true;
      continue;
    }
    if (
      words.typed(each) ||
      bindingArrayWords({ ...reading, value: each }, { call, words, pending, seen })
    )
      return true;
  }
  return false;
}

interface ArrayReading {
  readonly value: Expression;
  readonly text: boolean;
}

/** Selected pattern paths retain their declared Error identity during element conversion. */
function writtenElementErrors(
  value: Expression,
  call: Node,
  words: ArrayWords,
  pending: ArrayReading[],
): boolean {
  if (arrayWritesUnfollowed(value, call)) return true;
  for (const source of writtenArrayElements(value, call)) {
    if (source.array === true) {
      pending.push({ value: source.value, text: false });
      continue;
    }
    if (source.keys.length > 0) {
      if (words.error(source.value, source.keys)) return true;
    } else if (elementErrors([source.value], words, pending)) return true;
  }
  return false;
}

/** A whole lexical binding not already followed while reading this array's elements. */
function unseenArrayBinding(value: Expression, seen: Set<FrameBinding>): FrameBinding | undefined {
  if (!isIdentifier(value)) return undefined;
  const selected = frameBindingOf(value);
  if (selected === undefined) return undefined;
  if (selected.keys.length > 0 || seen.has(selected.binding)) return undefined;
  seen.add(selected.binding);
  return selected.binding;
}

/** The errors an array writes as elements, including arrays it spreads or nests. */
function literalErrors(
  array: ArrayLiteralExpression,
  words: ArrayWords,
  pending: ArrayReading[],
): boolean {
  return elementErrors(array.elements, words, pending);
}

/** Each inserted or literal element retains its own text conversion, including spread arrays. */
function elementErrors(
  elements: readonly Expression[],
  words: ArrayWords,
  pending: ArrayReading[],
): boolean {
  for (const element of elements) {
    if (isSpreadElement(element)) pending.push({ value: element.expression, text: false });
    else if (words.error(element)) return true;
    else pending.push({ value: element, text: true });
  }
  return false;
}

/**
 * A prior own method assignment replaces the native method; toString delegates to join as well,
 * but only while toString is the native one: what is written there runs in its place, and a
 * deletion that removes it gives the native one back.
 */
function arrayMethodOverridden(receiver: Expression, method: string, call: Node): boolean {
  const own = ownMethods(receiver, call, method);
  if (own.get(method)?.own === true) return true;
  const written = own.get('toString');
  const native = written === undefined || written.inherited === true;
  return method === 'toString' && native && own.get('join')?.own === true;
}

/** The last source-written override, with its value retained for result-sensitive selectors. */
export function arrayMethodOverride(
  receiver: Expression,
  method: string,
  call: Node,
): ArrayMethodOverride | undefined {
  return ownMethods(receiver, call, method).get(method);
}

/**
 * Prior direct writes and native object mutators share one lexical array identity. A write the
 * block's earlier statements may make otherwise — in a branch, an operand, the read's own
 * statement — or another function may make before the read leaves the methods it names unproven;
 * a statement's operands run before the write the statement itself makes, and a call's arguments
 * after the call selected its method.
 */
function ownMethods(receiver: Expression, call: Node, method?: string): OwnMethods {
  const own: OwnMethods = new Map();
  const root = arrayIdentity(receiver);
  if (root === undefined) return own;
  let statement = call;
  while (!isSourceFile(statement.parent) && !isBlock(statement.parent))
    statement = statement.parent;
  const owner = executionOwner(call);
  const held: HeldMethods = new Map();
  for (const before of statement.parent.statements) {
    if (before === statement) break;
    statementMethodWrites(before, root, { owner, own, held });
  }
  const selected = selectedMethod(call, method, root);
  possibleMethodWrites(statement, {
    root,
    owner,
    own,
    selected,
    read: call,
    definite: undefined,
  });
  deferredMethodWrites(call, root, own, statement.parent);
  if (arrayWritesUnfollowed(receiver, call)) forgetMethods(own);
  return own;
}

/**
 * A statement's operands run before the write the statement itself makes, in source order. A
 * definition leaves its key unproven for good where it may leave an accessor or a fixed value: a
 * later write calls the setter, or is refused, and does not replace the method.
 */
function statementMethodWrites(
  before: Node,
  root: FrameBinding,
  {
    owner,
    own,
    held,
  }: { readonly owner: Node; readonly own: OwnMethods; readonly held: HeldMethods },
): void {
  const top = definiteExpression(before, root);
  const assignment = top === undefined ? undefined : ownMethodAssignment(top, root);
  const definite = assignment !== undefined || (top !== undefined && isCallExpression(top));
  const writes = { root, owner, own, held, definite: definite ? top : undefined };
  const prior = new Map(own);
  possibleMethodWrites(before, writes);
  if (top === undefined) return;
  releaseHeld(top, root, held);
  holdDefinition(top, root, held, own);
  if (assignment !== undefined) own.set(assignment.key, assignment);
  callMethodWrites(top, root, own);
  deletedMethod(top, root, own, { prior });
  for (const [key, configurable] of held)
    own.set(key, configurable ? { own: false, configurable: true } : { own: false });
}

/** Whether each key a definition left unproven may be redefined or deleted by a later one. */
type HeldMethods = Map<string, boolean>;

interface MethodWrites {
  readonly root: FrameBinding;
  readonly owner: Node;
  readonly own: OwnMethods;
  readonly definite: Node | undefined;
  /** The read, which what runs after it does not precede; none where the statement runs whole. */
  readonly read?: Node;
  readonly held?: HeldMethods;
  readonly selected?: SelectedMethod | undefined;
}

/**
 * The read's own execution makes these writes in the order it runs them, before its later definite
 * proofs: the operands of a call before the call. What runs after the read, whatever its place in
 * the source, is left out; what holds the read, a call it is an operand of, still counts.
 */
function possibleMethodWrites(statement: Node, writes: MethodWrites): void {
  let done = false;
  const visit = (node: Node): void => {
    if (done && !holds(node, writes.read)) return;
    for (const child of inRunOrder(node)) visit(child);
    const keys = node === writes.definite ? [] : writtenMethods(node, writes.root);
    if (keys.length > 0 && executionOwner(node) === writes.owner && framedPossibleBranch(node))
      unprovenWrites(node, keys, writes, evaluatedForSure(node, statement));
    if (node === writes.read) done = true;
  };
  visit(statement);
}

/** Whether a node holds another, by their places in the source. */
function holds(node: Node, inner: Node | undefined): boolean {
  return inner !== undefined && node.pos <= inner.pos && inner.end <= node.end;
}

/**
 * The methods a write may replace are unproven, unless the write comes after the read or, for the
 * selected method, after the selection; a definition's may stay so for good. What the write leaves
 * of the attributes a method had, whether it ran or not, is what stays: a write of the value alone
 * keeps them, a definition that does not name them does too.
 */
function unprovenWrites(
  node: Node,
  keys: readonly string[],
  writes: MethodWrites,
  sure: boolean,
): void {
  const { selected, read } = writes;
  if (read !== undefined && writtenAfterRead(node, read, writes.root)) return;
  if (sure && writes.held !== undefined) releaseHeld(node, writes.root, writes.held);
  if (writes.held !== undefined) holdDefinition(node, writes.root, writes.held, writes.own);
  const defined = isDeleteExpression(node)
    ? undefined
    : definedMethods(node, writes.root, { previous: writes.own });
  const deleting = isDeleteExpression(node);
  const assigns = sure && !deleting && defined === undefined && writesExactly(node, writes.root);
  const how = { sure, assigns, deleting, defined, deleted: deletedReceiver(node) };
  for (const key of keys)
    if (selected === undefined || !writtenAfterSelection(node, key, selected))
      writes.own.set(key, afterWrite(key, how, writes));
}

/** Whether the members a write names are the array's own, not those of a name that may hold another. */
function writesExactly(node: Node, root: FrameBinding): boolean {
  if (isCallExpression(node)) {
    const target = mutatorInvocation(node)?.args[0] ?? node.arguments[0];
    return target !== undefined && arrayIdentity(target) === root;
  }
  return framedWrittenTargets(node).every((target) => {
    const member = unwrapped(target);
    if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return true;
    return !mayBeArray(member.expression, root) || arrayIdentity(member.expression) === root;
  });
}

/** What a write that may run leaves of a method it names, as its kind and its certainty say. */
function afterWrite(
  key: string,
  how: {
    readonly sure: boolean;
    readonly assigns: boolean;
    readonly deleting: boolean;
    readonly defined: OwnMethods | undefined;
    readonly deleted: Expression | undefined;
  },
  writes: MethodWrites,
): ArrayMethodOverride {
  const previous = writes.own.get(key);
  if (how.assigns && writes.held?.has(key) !== true) return afterAssignment(previous);
  if (how.deleting) return afterDeletion(how, previous, writes.root);
  const written = (how.defined ?? writes.own).get(key);
  return how.sure ? afterSureWrite(written) : afterPossibleWrite(previous, written);
}

/**
 * A definition of the array leaves a method unproven where it is neither a custom function nor a
 * writable value; the key stays redefinable only where the descriptor says it is configurable. The
 * methods before the definition are what it carries the attributes it left unsaid over from.
 */
function holdDefinition(
  node: Node,
  root: FrameBinding,
  held: HeldMethods,
  previous: OwnMethods,
): void {
  const defined = definedMethods(node, root, { previous });
  if (defined === undefined) return;
  for (const [key, method] of defined) {
    if (method.own || method.writable === true) continue;
    held.set(key, (held.get(key) ?? true) && method.configurable === true);
  }
}

/**
 * A definite redefinition or deletion replaces a configurable property, setter and all: one of the
 * array itself, not of a name that may hold another.
 */
function releaseHeld(top: Node, root: FrameBinding, held: HeldMethods): void {
  const replaced =
    definedMethods(top, root, { exact: true }) ?? new Map<string, ArrayMethodOverride>();
  if (isExpression(top)) deletedMethod(top, root, replaced, { exact: true });
  if (replaced.size >= OWN_METHODS.size) return;
  for (const key of replaced.keys()) if (held.get(key) === true) held.delete(key);
}

/**
 * The methods one call of Object.defineProperty or Object.defineProperties defines on the array, or
 * on what may be it unless `exact` asks for the array itself, read against the methods `previous`
 * holds from before it.
 */
function definedMethods(
  node: Node,
  root: FrameBinding,
  { previous, exact = false }: { readonly previous?: OwnMethods; readonly exact?: boolean } = {},
): OwnMethods | undefined {
  if (!isCallExpression(node)) return undefined;
  const invoked = mutatorInvocation(node);
  const target = invoked?.args[0];
  if (
    invoked === undefined ||
    target === undefined ||
    !(exact ? arrayIdentity(target) === root : mayBeArray(target, root)) ||
    (invoked.path !== PATHS.property && invoked.path !== PATHS.properties)
  )
    return undefined;
  const defined: OwnMethods = new Map(previous);
  callMethodWrites(node, root, defined);
  if (previous === undefined) return defined;
  return new Map([...defined].filter(([key, method]) => previous.get(key) !== method));
}

/**
 * Another function that may run before the read may write any method at any point before it, and
 * so may a write after it that a loop around the read brings back to it. A method the read's block
 * wrote before the read stays proven against the second, where each loop that brings the write back
 * runs that block again, and so writes the method anew before the read; and a custom function the
 * write installs replaces a custom one, which stays custom, though no longer the one it was.
 */
function deferredMethodWrites(call: Node, root: FrameBinding, own: OwnMethods, block: Node): void {
  const owner = executionOwner(call);
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const keys = writtenMethods(node, root);
    if (keys.length > 0 && mayPrecedeRead(node, call, root) && framedPossibleBranch(node)) {
      const sameRun = executionOwner(node) === owner;
      const again = sameRun && mayRunAgain(node, call, root, block);
      replaceProofs(
        own,
        sameRun ? keys.filter((key) => !overwrittenInPass(node, key, call, root)) : keys,
        {
          anew: (key) => {
            return (
              sameRun &&
              !again &&
              !recursesBetween(call, root, owner, own.get(key)?.value?.end ?? block.pos)
            );
          },
          custom: sameRun ? customInstalled(node, root) : new Set<string>(),
        },
      );
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
}

/**
 * A deferred write leaves the methods it names unproven, but for one written anew before the read,
 * and one that was proven custom where the write installs a custom function.
 */
function replaceProofs(
  own: OwnMethods,
  keys: readonly string[],
  {
    anew,
    custom,
  }: {
    readonly anew: (key: string) => boolean;
    readonly custom: ReadonlySet<string>;
  },
): void {
  for (const key of keys) {
    const proven = own.get(key)?.own === true;
    if (!proven || !anew(key)) own.set(key, { own: proven && custom.has(key) });
  }
}

/** The methods a write installs a custom function for, with the array's own identity. */
function customInstalled(node: Node, root: FrameBinding): ReadonlySet<string> {
  const installed: OwnMethods = new Map();
  const assignment = ownMethodAssignment(node, root);
  if (assignment !== undefined) installed.set(assignment.key, assignment);
  if (isCallExpression(node)) callMethodWrites(node, root, installed);
  return new Set([...installed].filter(([, method]) => method.own).map(([key]) => key));
}

/**
 * Whether a write runs in another function that may run first, or after the read where the read's
 * run comes again.
 */
function mayPrecedeRead(node: Node, call: Node, root: FrameBinding): boolean {
  const owner = executionOwner(call);
  const writer = executionOwner(node);
  if (writer !== owner) return !unreferencedLocalFunction(writer, owner);
  return node.pos >= call.end && mayRunAgain(node, call, root, owner);
}

/** The methods a write to the array may replace, whichever value it writes. */
function writtenMethods(node: Node, root: FrameBinding): readonly string[] {
  const written: OwnMethods = new Map();
  for (const target of framedWrittenTargets(node))
    for (const key of assignedMethods(target, root)) written.set(key, { own: false });
  if (isDeleteExpression(node)) deletedMethod(node, root, written);
  if (isCallExpression(node)) callMethodWrites(node, root, written);
  return [...written.keys()];
}

/** The methods an assignment to the array's member may replace: each its key's names allow. */
function assignedMethods(target: Expression, root: FrameBinding): readonly string[] {
  const member = unwrapped(target);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return [];
  if (!mayBeArray(member.expression, root)) return [];
  const key = frameMemberName(member);
  const opaque = isElementAccessExpression(member)
    ? framedKeyNames(member.argumentExpression)
    : undefined;
  const keys = key === undefined ? (opaque ?? [...OWN_METHODS]) : [key];
  return keys.filter((each) => OWN_METHODS.has(each));
}

/**
 * A completed deletion reveals an inherited method; an opaque key may remove either proof. It
 * deletes from what may be the array unless `exact` asks for the array itself.
 */
function deletedMethod(
  node: Expression,
  root: FrameBinding,
  own: OwnMethods,
  { exact = false, prior = own }: { readonly exact?: boolean; readonly prior?: OwnMethods } = {},
): void {
  if (!isDeleteExpression(node)) return;
  const member = unwrapped(node.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return;
  if (!(exact ? arrayIdentity(member.expression) === root : mayBeArray(member.expression, root)))
    return;
  const key = frameMemberName(member);
  if (key === undefined) forgetMethods(own);
  else if (OWN_METHODS.has(key)) own.set(key, deletedFrom(member.expression, root, prior.get(key)));
}

/** Initializer traversal still requires whole binding identity after the selected type was checked. */
function bindingArrayWords(
  reading: ArrayReading,
  context: {
    readonly call: Node;
    readonly words: ArrayWords;
    readonly pending: ArrayReading[];
    readonly seen: Set<FrameBinding>;
  },
): boolean {
  const { call, words, pending, seen } = context;
  const binding = unseenArrayBinding(reading.value, seen);
  if (binding === undefined) return false;
  if (writtenElementErrors(reading.value, call, words, pending)) return true;
  if (binding.initializer !== undefined)
    pending.push({ value: binding.initializer, text: reading.text });
  return false;
}
