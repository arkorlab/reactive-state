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
import {
  arrayWritesUnfollowed,
  type WrittenArrayElement,
  writtenArrayElements,
} from './framed-array-elements.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { givenValues, writtenAsWhole } from './framed-array-identity.ts';
import { defaultArrayComparison } from './framed-array-sorting.ts';
import {
  isNoArray,
  isScalarValue,
  mayBecomeArray,
  mayStartAsArray,
} from './framed-array-starts.ts';
import { writtenArrayWords } from './framed-array-word-origins.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { UnfollowableError } from './framed-getter-writes.ts';
import { mutatorInvocation } from './framed-mutator-calls.ts';
import { destructuredList } from './framed-nested-lists.ts';
import { methodMayBeOverridden } from './framed-overridden-methods.ts';
import { sourceChanged } from './framed-pattern-sources.ts';
import { isScalarType } from './framed-scalar-types.ts';
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

/**
 * An implicit conversion, a `+` or `+=` operand or a template span, reads the elements of an array it
 * can follow: a literal, its constant aliases, a written type that says it holds errors, what the
 * program writes into it, and what a name is given where it is assigned, where that is a literal, a
 * name or a scalar; a call, a member or a choice of arrays may hand an array on, and is refused. A
 * name it cannot follow, a parameter assigned as a whole (`count += 1`), a name a swap or a loop
 * writes, an array written through an element, is taken as the program shows it: an operand is far
 * oftener text or a number than a list, and `String(name)` alone refuses such a name.
 */
export function framedArrayOperand(
  value: Expression | undefined,
  words: ArrayWords,
  call: Node,
): boolean {
  return value !== undefined && arrayError(value, words, call, 'followed');
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

/** How an array the compile cannot follow reads: refused as one that may hold an error, or only as far as it is followed. */
type Reading = 'followed' | 'refused';

/**
 * Literal arrays, their lexical aliases, and explicitly array-typed inputs retain element words. A
 * name written as a whole, a list that may have changed and an array written where no reader follows
 * hold an error where the reading is `refused`, the default; where it is `followed` they are read by
 * what they are shown to hold alone.
 */
export function arrayError(
  value: Expression,
  words: ArrayWords,
  call: Node,
  reading: Reading = 'refused',
): boolean {
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
      bindingArrayWords(each, { call, words, pending, seen, reading })
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
  context: { readonly pending: Expression[]; readonly reading: Reading },
): boolean {
  const { pending, reading } = context;
  const unfollowed = arrayWritesUnfollowed(value, call, (element, keys) =>
    words.error(element, keys),
  );
  if (unfollowed && reading === 'refused') return true;
  const sources = unfollowed ? explicitWrites(value, call) : writtenArrayElements(value, call);
  if (sources === undefined) return true;
  for (const source of sources) {
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

/**
 * What the program writes into an array it does not follow the identity of, an insertion and an
 * element assignment on its name: read by an operand all the same, so that an error pushed into a
 * list the code also gives another list is still one. Where a native object mutator may write the
 * array nothing here can be read, and none is returned.
 */
function explicitWrites(value: Expression, call: Node): readonly WrittenArrayElement[] | undefined {
  try {
    return writtenArrayElements(value, call);
  } catch (error) {
    if (error instanceof UnfollowableError) return undefined;
    throw error;
  }
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
    readonly reading: Reading;
    readonly seen: Set<FrameBinding>;
  },
): boolean {
  const { call, words, pending, seen, reading } = context;
  const binding = unseenArrayBinding(value, seen);
  if (binding === undefined) return false;
  if (reading === 'refused' && rewrittenArray(binding)) return true;
  if (writtenElementErrors(value, call, words, { pending, reading })) return true;
  if (reading === 'followed' && !followedGivens(binding)) return true;
  if (binding.initializer !== undefined) pending.push(binding.initializer);
  return false;
}

/**
 * Whether a name written as a whole elsewhere may be read as it is shown to hold. A name the code
 * writes as a scalar is no array. Any other name is refused unless everything it is given where it
 * is assigned is no array (a literal, an operator's result, a function): an array literal, a name, a
 * call, a member, a choice that ends at one, and a value a pattern or a loop head gives, may be a
 * list that holds an error, and the name is refused as the reading that refuses every list does.
 */
function followedGivens(binding: FrameBinding): boolean {
  if (writtenScalar(binding)) return true;
  return givenValues(binding).every(
    (given) => given !== undefined && (isNoArray(given) || isScalarName(given)),
  );
}

/** Whether a value is a name the code writes as a scalar: what a swap of names gives one of them. */
function isScalarName(value: Expression): boolean {
  const name = unwrapped(value);
  const selected = isIdentifier(name) ? frameBindingOf(name) : undefined;
  return selected?.keys.length === 0 && writtenScalar(selected.binding);
}

/**
 * Whether the code writes a name as a text, a number, a boolean or a bigint: its annotation says so,
 * or, with none, it starts as a literal or an operator's scalar. TypeScript refuses to give such a
 * name an array, as the compile trusts a written type that excludes an error, so what it is given
 * is no array, a call result included (`text = JSON.stringify(value)`).
 */
function writtenScalar(binding: FrameBinding): boolean {
  if (binding.type !== undefined) return isScalarType(binding.type);
  return binding.initializer !== undefined && isScalarValue(binding.initializer);
}
