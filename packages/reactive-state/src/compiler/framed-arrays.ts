import {
  type Expression,
  type ArrayLiteralExpression,
  type CallExpression,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { arrayWritesUnfollowed, writtenArrayElements } from './framed-array-elements.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { writtenAsWhole } from './framed-array-identity.ts';
import { defaultArrayComparison } from './framed-array-sorting.ts';
import { mayBecomeArray, mayStartAsArray } from './framed-array-starts.ts';
import { writtenArrayWords } from './framed-array-word-origins.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { mutatorInvocation } from './framed-mutator-calls.ts';
import { destructuredList } from './framed-nested-lists.ts';
import { methodMayBeOverridden } from './framed-overridden-methods.ts';
import { sourceChanged } from './framed-pattern-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';

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
      !sourceArrayFunction(member) &&
      defaultArrayComparison(receiver, node, node.arguments) &&
      arrayError(receiver, words, node)
    );
  if (method !== 'join' && method !== 'toString') return false;
  if (sourceArrayFunction(member)) return false;
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
  return writtenArrayWords(value, { created });
}

/** Native String conversion reads the elements of an array, the language's method answering for it. */
export function framedArrayString(
  value: Expression | undefined,
  words: ArrayWords,
  call: Node,
): boolean {
  return value !== undefined && arrayError(value, words, call);
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
  const pending: Expression[] = [value];
  const seen = new Set<FrameBinding>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const each = unwrapped(next);
    if (isArrayLiteralExpression(each)) {
      if (literalErrors(each, words, pending)) return true;
      continue;
    }
    if (
      words.typed(each) ||
      (isIdentifier(each) &&
        destructuredList(
          each,
          (element, keys) => words.error(element, keys),
          (source) => sourceChanged(source, call, (element, keys) => words.error(element, keys)),
        )) ||
      bindingArrayWords(each, { call, words, pending, seen })
    )
      return true;
  }
  return false;
}

/** Selected pattern paths retain their declared Error identity during element conversion. */
function writtenElementErrors(
  value: Expression,
  call: Node,
  words: ArrayWords,
  pending: Expression[],
): boolean {
  if (arrayWritesUnfollowed(value, call, (element, keys) => words.error(element, keys)))
    return true;
  for (const source of writtenArrayElements(value, call)) {
    if (source.array === true) {
      pending.push(source.value);
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
  pending: Expression[],
): boolean {
  return elementErrors(array.elements, words, pending);
}

/** Each inserted or literal element retains its own text conversion, including spread arrays. */
function elementErrors(
  elements: readonly Expression[],
  words: ArrayWords,
  pending: Expression[],
): boolean {
  for (const element of elements) {
    if (isSpreadElement(element)) pending.push(element.expression);
    else if (words.error(element)) return true;
    else pending.push(element);
  }
  return false;
}

/**
 * Whether the file may give an array a method of this name of its own: a write, a definition or a
 * deletion of a member of that name, a key the compile cannot read, a source or a descriptor of a
 * native mutator that may carry it, or another prototype for an array. What an array answers to the
 * name is the language's method unless it may; the text conversions here always read it so, and a
 * reader of the answer of a method refuses where it may not.
 */
export function arrayMethodMayBeOverridden(call: Node, method: string): boolean {
  return methodMayBeOverridden(call.getSourceFile(), method, mutatorInvocation);
}

/**
 * Whether a name that starts as a written array, or as a name that stands for one, is written as a
 * whole elsewhere: it may hold another array than the one the chain of names ends at. A chain that
 * ends at a value that is no array (a scalar, a function, an object) is no array the compile started
 * from, but a name that is given an array elsewhere holds it afterwards, and is refused alike.
 */
function rewrittenArray(binding: FrameBinding): boolean {
  return writtenAsWhole(binding) && (mayStartAsArray(binding) || mayBecomeArray(binding));
}

/**
 * Initializer traversal still requires whole binding identity after the selected type was checked: a
 * name written as a whole elsewhere may hold another array than its initializer, and is refused.
 */
function bindingArrayWords(
  value: Expression,
  context: {
    readonly call: Node;
    readonly words: ArrayWords;
    readonly pending: Expression[];
    readonly seen: Set<FrameBinding>;
  },
): boolean {
  const { call, words, pending, seen } = context;
  const binding = unseenArrayBinding(value, seen);
  if (binding === undefined) return false;
  if (rewrittenArray(binding) || writtenElementErrors(value, call, words, pending)) return true;
  if (binding.initializer !== undefined) pending.push(binding.initializer);
  return false;
}
