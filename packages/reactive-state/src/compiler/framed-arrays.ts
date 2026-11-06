import {
  type Expression,
  type ArrayLiteralExpression,
  type CallExpression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSourceFile,
  isSpreadElement,
  isSpreadAssignment,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { writtenArrayElements } from './framed-array-elements.ts';
import {
  sourceArrayFunction,
  writtenArrayFunction,
  writtenArrayKey,
} from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { arrayRestBinding } from './framed-array-rest.ts';
import { defaultArrayComparison } from './framed-array-sorting.ts';
import { writtenArrayWords } from './framed-array-word-origins.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedKeyNames } from './framed-keys.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { framedPossibleBranch } from './framed-writes.ts';
import { constantValue } from './numbers.ts';

/** Native array text conversion observes the error words its selected elements carry. */

interface ArrayWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

const OWN_METHODS = new Set([
  'at',
  'concat',
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flat',
  'flatMap',
  'forEach',
  'join',
  'map',
  'pop',
  'reduce',
  'reduceRight',
  'shift',
  'slice',
  'some',
  'sort',
  'splice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'toString',
  'with',
]);
const ACCESSOR_KEYS = new Set(['get', 'set']);

export interface ArrayMethodOverride {
  readonly own: boolean;
  readonly value?: Expression | MethodDeclaration;
}

type OwnMethods = Map<string, ArrayMethodOverride>;

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

/** A prior own method assignment replaces the native method; toString delegates to join as well. */
function arrayMethodOverridden(receiver: Expression, method: string, call: Node): boolean {
  const own = ownMethods(receiver, call);
  return own.get(method)?.own === true || (method === 'toString' && own.get('join')?.own === true);
}

/** The last source-written override, with its value retained for result-sensitive selectors. */
export function arrayMethodOverride(
  receiver: Expression,
  method: string,
  call: Node,
): ArrayMethodOverride | undefined {
  return ownMethods(receiver, call).get(method);
}

/**
 * Prior direct writes and native object mutators share one lexical array identity. A write the
 * block's earlier statements may make otherwise — in a branch, an operand, the read's own
 * statement — or another function may make before the read leaves the methods it names unproven;
 * a statement's operands run before the write the statement itself makes.
 */
function ownMethods(receiver: Expression, call: Node): OwnMethods {
  const own: OwnMethods = new Map();
  const root = arrayIdentity(receiver);
  if (root === undefined) return own;
  let statement = call;
  while (!isSourceFile(statement.parent) && !isBlock(statement.parent))
    statement = statement.parent;
  const owner = executionOwner(call);
  for (const before of statement.parent.statements) {
    if (before === statement) break;
    statementMethodWrites(before, root, { owner, own });
  }
  possibleMethodWrites(statement, { root, owner, own, definite: undefined, until: call.end });
  deferredMethodWrites(call, root, own);
  return own;
}

/** A statement's operands run before the write the statement itself makes, in source order. */
function statementMethodWrites(
  before: Node,
  root: FrameBinding,
  { owner, own }: { readonly owner: Node; readonly own: OwnMethods },
): void {
  const top = isExpressionStatement(before) ? before.expression : undefined;
  const assignment = top === undefined ? undefined : ownMethodAssignment(top, root);
  const definite = assignment !== undefined || (top !== undefined && isCallExpression(top));
  const writes = { root, owner, own, definite: definite ? top : undefined, until: before.end };
  possibleMethodWrites(before, writes);
  if (top === undefined) return;
  if (assignment !== undefined) own.set(assignment.key, assignment);
  callMethodWrites(top, root, own);
  deletedMethod(top, root, own);
}

interface MethodWrites {
  readonly root: FrameBinding;
  readonly owner: Node;
  readonly own: OwnMethods;
  readonly definite: Node | undefined;
  readonly until: number;
}

/** The read's own execution makes these writes in source order, before its later definite proofs. */
function possibleMethodWrites(statement: Node, writes: MethodWrites): void {
  const pending: Node[] = [statement];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.pos >= writes.until) continue;
    const keys = node === writes.definite ? [] : writtenMethods(node, writes.root);
    if (keys.length > 0 && executionOwner(node) === writes.owner && framedPossibleBranch(node))
      for (const key of keys) writes.own.set(key, { own: false });
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
}

/** Another function that may run before the read may write any method at any point before it. */
function deferredMethodWrites(call: Node, root: FrameBinding, own: OwnMethods): void {
  const owner = executionOwner(call);
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const keys = writtenMethods(node, root);
    const writer = keys.length > 0 ? executionOwner(node) : owner;
    if (writer !== owner && !unreferencedLocalFunction(writer, owner) && framedPossibleBranch(node))
      for (const key of keys) own.set(key, { own: false });
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
}

/** The methods a write to the array may replace, whichever value it writes. */
function writtenMethods(node: Node, root: FrameBinding): readonly string[] {
  const written: OwnMethods = new Map();
  if (isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind))
    for (const key of assignedMethods(node.left, root)) written.set(key, { own: false });
  if (isDeleteExpression(node)) deletedMethod(node, root, written);
  if (isCallExpression(node)) callMethodWrites(node, root, written);
  return [...written.keys()];
}

/** Simple, compound and logical assignments alike. */
function assignmentOperator(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

/** The methods an assignment to the array's member may replace: each its key's names allow. */
function assignedMethods(target: Expression, root: FrameBinding): readonly string[] {
  const member = unwrapped(target);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return [];
  if (arrayIdentity(member.expression) !== root) return [];
  const key = frameMemberName(member);
  const opaque = isElementAccessExpression(member)
    ? framedKeyNames(member.argumentExpression)
    : undefined;
  const keys = key === undefined ? (opaque ?? [...OWN_METHODS]) : [key];
  return keys.filter((each) => OWN_METHODS.has(each));
}

/** A completed deletion reveals an inherited method; an opaque key may remove either proof. */
function deletedMethod(node: Expression, root: FrameBinding, own: OwnMethods): void {
  if (!isDeleteExpression(node)) return;
  const member = unwrapped(node.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return;
  if (arrayIdentity(member.expression) !== root) return;
  const key = frameMemberName(member);
  if (key === undefined) forgetMethods(own);
  else if (OWN_METHODS.has(key)) own.set(key, { own: false });
}

/** Native object mutators replace own methods in source order, retaining unknown writes as unknown. */
function callMethodWrites(node: Expression, root: FrameBinding, own: OwnMethods): void {
  if (!isCallExpression(node)) return;
  const target = node.arguments[0];
  if (target === undefined || arrayIdentity(target) !== root) return;
  const path = globalPathOf(unwrapped(node.expression))?.join('.');
  if (path === undefined) return;
  switch (path) {
    case 'Object.assign': {
      for (const source of node.arguments.slice(1)) assignMethods(source, own);
      break;
    }
    case 'Object.defineProperty': {
      defineMethod(node, own);
      break;
    }
    case 'Object.defineProperties': {
      const descriptors = node.arguments[1];
      const value = descriptors === undefined ? undefined : unwrapped(descriptors);
      if (value !== undefined && isObjectLiteralExpression(value)) descriptorMethods(value, own);
      else forgetMethods(own);
      break;
    }
    default: {
      break;
    }
  }
}

/** Each source's last explicitly written field wins; an unknown source may restore native methods. */
function assignMethods(source: Expression, own: OwnMethods): void {
  const value = unwrapped(source);
  if (!isObjectLiteralExpression(value)) {
    forgetMethods(own);
    return;
  }
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      forgetMethods(own);
      continue;
    }
    const key = writtenArrayKey(property.name);
    if (key === undefined) forgetMethods(own);
    else if (OWN_METHODS.has(key)) {
      own.set(key, propertyOverride(property));
    }
  }
}

/** A written own method or callable value, with unknown entries kept unproven. */
function propertyOverride(property: Node): ArrayMethodOverride {
  if (isMethodDeclaration(property)) return { own: true, value: property };
  if (!isPropertyAssignment(property)) return { own: false };
  return { own: knownNonNative(property.initializer), value: property.initializer };
}

/** One statically named data descriptor, including restoration to the native implementation. */
function defineMethod(call: CallExpression, own: OwnMethods): void {
  const keyNode = call.arguments[1];
  const key = keyNode === undefined ? undefined : constantValue(keyNode);
  if (typeof key !== 'string') {
    forgetMethods(own);
    return;
  }
  if (OWN_METHODS.has(key)) own.set(key, descriptorFunction(call.arguments[2]));
}

/** Object.defineProperties selects each descriptor by its written property name. */
function descriptorMethods(descriptors: ObjectLiteralExpression, own: OwnMethods): void {
  for (const property of descriptors.properties) {
    if (isSpreadAssignment(property)) {
      forgetMethods(own);
      continue;
    }
    const key = writtenArrayKey(property.name);
    if (key === undefined) forgetMethods(own);
    else if (OWN_METHODS.has(key)) {
      own.set(
        key,
        isPropertyAssignment(property) ? descriptorFunction(property.initializer) : { own: false },
      );
    }
  }
}

/** A written value function proves a custom implementation; getters and unknown values do not. */
function descriptorFunction(descriptor: Expression | undefined): ArrayMethodOverride {
  if (descriptor === undefined) return { own: false };
  const value = unwrapped(descriptor);
  if (!isObjectLiteralExpression(value)) return { own: false };
  let custom: ArrayMethodOverride = { own: false };
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) custom = { own: false };
    else {
      const key = writtenArrayKey(property.name);
      if (key === undefined || ACCESSOR_KEYS.has(key)) custom = { own: false };
      else if (key === 'value')
        custom = isPropertyAssignment(property)
          ? { own: knownNonNative(property.initializer), value: property.initializer }
          : { own: false };
    }
  }
  return custom;
}

/** An opaque write can replace either method and therefore removes a proof of a custom method. */
function forgetMethods(own: OwnMethods): void {
  for (const method of OWN_METHODS) own.set(method, { own: false });
}

/** One direct assignment to the native method selected by a call. */
function ownMethodAssignment(
  node: Node,
  root: FrameBinding,
): (ArrayMethodOverride & { readonly key: string }) | undefined {
  if (!isBinaryExpression(node) || node.operatorToken.kind !== SyntaxKind.EqualsToken)
    return undefined;
  const member = unwrapped(node.left);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const key = frameMemberName(member);
  if (key === undefined || !OWN_METHODS.has(key) || arrayIdentity(member.expression) !== root)
    return undefined;
  return {
    key,
    own: sourceArrayFunction(node.right) || knownNonNative(node.right),
    value: node.right,
  };
}

/** A written non-callable join makes native toString fall back to the ordinary object tag. */
function knownNonNative(expression: Expression): boolean {
  const value = unwrapped(expression);
  return (
    writtenArrayFunction(value) ||
    constantValue(value) !== undefined ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    globalPathOf(value)?.join('.') === 'undefined'
  );
}

/** The declaration whose array value a name or a chain of lexical aliases denotes. */
function arrayIdentity(value: Expression): FrameBinding | undefined {
  let each = unwrapped(value);
  const rest = arrayRestBinding(each);
  if (rest !== undefined) return rest;
  const seen = new Set<FrameBinding>();
  let root: FrameBinding | undefined;
  while (isIdentifier(each)) {
    const selected = frameBindingOf(each);
    if (selected === undefined) return undefined;
    if (selected.keys.length > 0 || seen.has(selected.binding)) return undefined;
    root = selected.binding;
    seen.add(root);
    if (root.initializer === undefined) return root;
    each = unwrapped(root.initializer);
  }
  return isArrayLiteralExpression(each) ? root : undefined;
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
