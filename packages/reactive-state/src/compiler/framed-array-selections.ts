import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type SpreadElement,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { arrayCopyMayBeOverridden, arrayCopyViews } from './framed-array-copies.ts';
import { writtenArrayElements } from './framed-array-elements.ts';
import { entryArrayViews } from './framed-array-enumerations.ts';
import { arrayFactoryViews } from './framed-array-factories.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { arrayProjectedViews, arrayProjectionMayBeOverridden } from './framed-array-projections.ts';
import { arrayRestView, type ArrayElementView } from './framed-array-rest.ts';
import { arrayMethodMayBeOverridden } from './framed-arrays.ts';
import { asyncArrayFactoryViews } from './framed-async-array-factories.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { asyncFoundElements } from './framed-find-results.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { UnfollowableError } from './framed-getter-writes.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { bindingUses } from './framed-local-uses.ts';
import { mapperRestReadingViews } from './framed-mapper-rest.ts';
import {
  indexedReading,
  literalKeyedReading,
  nestedArrayReadings,
} from './framed-nested-selections.ts';
import { framedCondition } from './framed-sources.ts';
import { framedAssignedSources, framedPossibleBranch, reachedLoopRead } from './framed-writes.ts';
import { constantValue } from './numbers.ts';
import { readsBinding } from './scope.ts';

/** Native array element selections retain the error identity of their possible results. */

type ElementReading = ArrayElementView;

interface ElementProof {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression, index: number | undefined) => boolean;
  readonly spread?: (
    spread: SpreadElement,
    array: ArrayLiteralExpression,
    position: number,
    keys: readonly string[],
  ) => readonly ArrayElementView[] | undefined;
}

/** Source-written arrays and native array annotations supply a native at call's selected element. */
export function framedArrayAt(node: Expression, proof: ElementProof): boolean | undefined {
  if (!isCallExpression(node)) return undefined;
  const selected = nativeSelection(node);
  if (selected === undefined) return undefined;
  const { receiver } = selected;
  if (!selected.borrowed && arrayMethodMayBeOverridden(node, 'at')) return true;
  const index = selected.unknown ? undefined : selectedIndex(selected.argument);
  if (index !== undefined && !Number.isFinite(index)) return false;
  return selectedError(receiver, index, proof, node);
}

interface AtSelection {
  readonly receiver: Expression;
  readonly argument: Expression | undefined;
  readonly unknown: boolean;
  readonly borrowed: boolean;
}

/** Borrowed native calls retain their receiver even when an apply list is unknown. */
function nativeSelection(call: CallExpression): AtSelection | undefined {
  const borrowed = borrowedTextCall(call);
  if (borrowed?.path.join('.') === 'Array.prototype.at') {
    const argument =
      borrowed.applied === undefined
        ? atArgument(call, borrowed.given)
        : appliedArgument(borrowed.applied);
    return { receiver: borrowed.receiver, borrowed: true, ...argument };
  }
  const method = unwrapped(call.expression);
  if (!isPropertyAccessExpression(method) && !isElementAccessExpression(method)) return undefined;
  if (frameMemberName(method) !== 'at') return undefined;
  return {
    receiver: unwrapped(method.expression),
    ...atArgument(call, call.arguments),
    borrowed: false,
  };
}

/** Closed argument tuples retain one consumed slot; unknown or exposed tuples retain every index. */
function atArgument(
  call: CallExpression,
  given: readonly Expression[],
): Pick<AtSelection, 'argument' | 'unknown'> {
  const prefix = framedArgumentPrefix(call, given, 1);
  const argument = prefix.values[0];
  return {
    argument: argument !== undefined && isOmittedExpression(argument) ? undefined : argument,
    unknown: prefix.unknown || prefix.alternatives !== undefined,
  };
}

/** A written apply array contributes its first argument; other argument lists keep all indices possible. */
function appliedArgument(expression: Expression): Pick<AtSelection, 'argument' | 'unknown'> {
  let value = unwrapped(expression);
  const seen = new Set<Node>();
  const aliases = new Set<FrameBinding>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const selected = frameBindingOf(value);
    const initializer = constantInitializer(value);
    if (selected === undefined || initializer === undefined) break;
    aliases.add(selected.binding);
    value = unwrapped(initializer);
  }
  if (argumentArrayReached(expression, aliases)) return { argument: undefined, unknown: true };
  if (value.kind === SyntaxKind.NullKeyword || globalPathOf(value)?.join('.') === 'undefined')
    return { argument: undefined, unknown: false };
  if (!isArrayLiteralExpression(value)) return { argument: undefined, unknown: true };
  const argument = value.elements[0];
  if (argument === undefined || isOmittedExpression(argument))
    return { argument: undefined, unknown: false };
  return { argument, unknown: isSpreadElement(argument) };
}

/**
 * Only a whole constant alias chain retains an apply array before its entries can be exposed. A use
 * counts where it runs before the read: written before it, but for one in a destructuring pattern
 * whose source holds the read, or in a loop's condition, update or body on the next pass. Where
 * `reached`, one in what a pattern around the read destructures counts too; where false, for a
 * reader whose proof an exposure drops, only a loop body's uses repeat.
 */
export function argumentArrayExposed(
  expression: Expression,
  aliases: ReadonlySet<FrameBinding>,
  unchanged?: (name: Identifier) => boolean,
  reached: boolean | 'loops' = 'loops',
): boolean {
  if (aliases.size === 0) return false;
  const root = expression.getSourceFile();
  for (const alias of aliases) {
    for (const node of bindingUses(root, alias)) {
      if (argumentUseExposed(node, expression, aliases, reached) && unchanged?.(node) !== true)
        return true;
    }
  }
  return false;
}

/**
 * An exposure by any use that may run before the read: one written before it, one in what a
 * destructuring pattern around the read destructures, which runs first though written after, and
 * one in a loop's condition or update on the next pass — for a reader that keeps every candidate of
 * an exposed array, so that an exposure widens what it keeps and never drops a proof.
 */
export function argumentArrayReached(
  expression: Expression,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  return argumentArrayExposed(expression, aliases, undefined, true);
}

/** Earlier uses or possible closure uses lose the exact index, retaining lexical identity. */
function argumentUseExposed(
  name: Identifier,
  expression: Expression,
  aliases: ReadonlySet<FrameBinding>,
  reached: boolean | 'loops',
): boolean {
  if (!readsBinding(name)) return false;
  const selected = frameBindingOf(name);
  if (selected === undefined || name === selected.binding.name || !aliases.has(selected.binding))
    return false;
  if (name === unwrapped(expression)) return false;
  const reader = executionOwner(expression);
  const owner = executionOwner(name);
  if (owner === reader) {
    if (
      (name.pos >= expression.pos || destructuredFirst(expression, name)) &&
      !(reached === true && destructuredFirst(name, expression)) &&
      !reachedLoopRead(reached)(name, expression, selected.binding, reader)
    )
      return false;
  } else if (unreferencedLocalFunction(owner, reader)) return false;
  if (!framedPossibleBranch(name)) return false;
  const { parent } = useOf(name);
  return (
    !isVariableDeclaration(parent) ||
    parent.initializer === undefined ||
    unwrapped(parent.initializer) !== name ||
    !aliases.has(parent)
  );
}

/** Native at converts an omitted argument or primitive constant to its truncated numeric index. */
function selectedIndex(argument: Expression | undefined): number | undefined {
  if (argument === undefined) return 0;
  const value = unwrapped(argument);
  if (
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    globalPathOf(value)?.join('.') === 'undefined'
  )
    return 0;
  if (value.kind === SyntaxKind.TrueKeyword) return 1;
  const constant = constantValue(value, constantInitializer);
  return constant === undefined ? undefined : Math.trunc(Number(constant)) || 0;
}

/** Literal positions remain exact; unknown positions retain every possible written element. */
export function selectedError(
  receiver: Expression,
  index: number | undefined,
  proof: ElementProof,
  read?: Node,
): boolean {
  const pending: {
    readonly reading: ElementReading;
    readonly ancestors: ReadonlySet<Node>;
  }[] = [{ reading: { value: receiver, index }, ancestors: new Set<Node>() }];
  for (let branch = pending.pop(); branch !== undefined; branch = pending.pop()) {
    const { reading } = branch;
    const value = unwrapped(reading.value);
    if (branch.ancestors.has(value)) continue;
    const sources: ElementReading[] = [];
    if (readingError({ ...reading, value }, { proof, pending: sources, read })) return true;
    const ancestors = new Set([...branch.ancestors, value]);
    pending.push(...sources.map((source) => ({ reading: source, ancestors })));
  }
  return false;
}

/** Whole ordinary assignment sources retain their selected position; logical RHS stays opaque. */
function assignedArrays(value: Expression, index: number | undefined): readonly ElementReading[] {
  if (!isIdentifier(value)) return [];
  const readings: ElementReading[] = [];
  for (const source of framedAssignedSources(value)) {
    const parent = source.value.parent;
    if (
      source.keys.length > 0 ||
      (isBinaryExpression(parent) &&
        parent.right === source.value &&
        parent.operatorToken.kind !== SyntaxKind.EqualsToken)
    )
      continue;
    readings.push({ value: source.value, index });
  }
  return readings;
}

/**
 * Possible inserted values retain selection identity without converting nested arrays into their
 * elements. An array a native object mutator may write is not followed: it may hold an error.
 */
function insertedErrors(
  reading: ElementReading,
  read: Node | undefined,
  proof: ElementProof,
  pending: ElementReading[],
): boolean {
  if (read === undefined) return false;
  let written: ReturnType<typeof writtenArrayElements>;
  try {
    written = writtenArrayElements(reading.value, read, reading.index);
  } catch (error) {
    if (error instanceof UnfollowableError) return true;
    throw error;
  }
  for (const source of written) {
    const element = source.value;
    if (source.array === true) {
      pending.push({ value: element, index: undefined, keys: reading.keys });
      continue;
    }
    if (source.keys.length === 0 && isSpreadElement(element))
      pending.push({ value: element.expression, index: undefined, keys: reading.keys });
    else if (proof.error(element, [...source.keys, ...(reading.keys ?? [])])) return true;
  }
  return false;
}

/** A whole lexical array alias retains its initializer without inventing member types. */
function arrayInitializer(value: Expression): Expression | undefined {
  if (!isIdentifier(value)) return undefined;
  const selected = frameBindingOf(value);
  return selected === undefined || selected.keys.length > 0
    ? undefined
    : selected.binding.initializer;
}

/** Known positions ignore unrelated literal elements; spread positions remain conservatively possible. */
function literalError(
  array: ArrayLiteralExpression,
  reading: ElementReading,
  proof: ElementProof,
  pending: ElementReading[],
): boolean {
  const { index } = reading;
  const exact = !array.elements.some((each) => isSpreadElement(each));
  const position = index !== undefined && index < 0 ? array.elements.length + index : index;
  const start = reading.start ?? 0;
  const end = reading.end ?? array.elements.length;
  let elements: readonly (Expression | undefined)[] = array.elements;
  if (position !== undefined && exact) {
    elements = position >= start && position < end ? [array.elements[position]] : [];
  } else if (exact) elements = array.elements.slice(start, end);
  for (const element of elements) {
    if (element === undefined || isOmittedExpression(element)) continue;
    if (isSpreadElement(element)) pending.push(...spreadReadings(element, array, reading, proof));
    else if (keyedError(element, reading.keys, proof, pending)) return true;
  }
  return false;
}

/** A spread's source keeps every element possible; a known projection adds its values, read on by the keys. */
function spreadReadings(
  spread: SpreadElement,
  array: ArrayLiteralExpression,
  reading: ElementReading,
  proof: ElementProof,
): readonly ElementReading[] {
  const readings: ElementReading[] = [
    { value: spread.expression, index: undefined, keys: reading.keys },
  ];
  const { index } = reading;
  if (index === undefined || index < (reading.start ?? 0) || index >= (reading.end ?? Infinity))
    return readings;
  const projected = proof.spread?.(spread, array, index, reading.keys ?? []);
  if (projected !== undefined) readings.push(...projected);
  return readings;
}

/** Only unchanged whole const names supply an exact numeric selector. */
function constantInitializer(name: Identifier): Expression | undefined {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  const list = binding.parent;
  return /^const\s/u.test(list.getText(binding.getSourceFile())) ? binding.initializer : undefined;
}

/** Native predicate selectors retain any possible selected element, excluding indexes and booleans. */
export function framedArrayFind(call: CallExpression, proof: ElementProof): boolean | undefined {
  const selected = findSelection(call);
  if (selected === undefined) return undefined;
  if (!selected.borrowed && arrayMethodMayBeOverridden(call, selected.method)) return true;
  if (!selected.unknown) {
    const found = asyncFoundElements(call, selected.receiver, selected.method, stableSource);
    if (found !== undefined) return found.some((each) => proof.error(each));
    if (falsePredicate(selected.argument)) return false;
  }
  return selectedError(selected.receiver, undefined, proof, call);
}

interface FindSelection extends AtSelection {
  readonly method: string;
}

/** Direct and borrowed find/findLast share the same explicit receiver and first predicate slot. */
function findSelection(call: CallExpression): FindSelection | undefined {
  const borrowed = borrowedTextCall(call);
  const path = borrowed?.path.join('.');
  if (
    borrowed !== undefined &&
    (path === 'Array.prototype.find' || path === 'Array.prototype.findLast')
  ) {
    const args =
      borrowed.applied === undefined
        ? { argument: borrowed.given[0], unknown: isSpreadElement(borrowed.given[0] ?? call) }
        : appliedArgument(borrowed.applied);
    return {
      receiver: borrowed.receiver,
      method: borrowed.path.at(-1) ?? '',
      borrowed: true,
      ...args,
    };
  }
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const method = frameMemberName(member);
  if (method !== 'find' && method !== 'findLast') return undefined;
  const argument = call.arguments[0];
  return {
    receiver: unwrapped(member.expression),
    method,
    argument,
    unknown: argument !== undefined && isSpreadElement(argument),
    borrowed: false,
  };
}

/**
 * A written false body selects nothing; an async predicate's Promise is truthy, so it selects the
 * first element it visits, and without an exact answer every element stays possible.
 */
function falsePredicate(node: Expression | undefined): boolean {
  if (node === undefined) return false;
  const value = unwrapped(node);
  if (!(isArrowFunction(value) && !isBlock(value.body) && framedCondition(value.body) === false))
    return false;
  return !answersLater(value);
}

/** Concat's quiet slots, whose proof an exposure drops, count only a loop body's repeated uses. */
const provenSource = (receiver: Expression): boolean => stableSource(receiver, receiver, false);

/**
 * Only an unexposed whole array source retains an exact copy position. A use that may run before the
 * copy counts: in what a destructuring pattern around it destructures, and in a loop's condition or
 * update, unless `reached` is false.
 */
function stableSource(expression: Expression, at: Expression = expression, reached = true) {
  let value = unwrapped(expression);
  const aliases = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || aliases.has(selected.binding))
      return false;
    aliases.add(selected.binding);
    if (selected.binding.initializer === undefined) return false;
    value = unwrapped(selected.binding.initializer);
  }
  return !argumentArrayExposed(at, aliases, undefined, reached);
}

/** Copied slots retain their creation-time receiver and selected offset. */
function expandCopiedArray(reading: ElementReading, pending: ElementReading[]): boolean {
  const rest = arrayRestView(reading.value, reading.index);
  if (rest !== undefined) {
    pending.push({
      ...rest,
      start: (rest.start ?? 0) + (reading.start ?? 0),
      keys: [...(rest.keys ?? []), ...(reading.keys ?? [])],
    });
    return true;
  }
  const entries = entryArrayViews(reading.value, reading.index, stableSource);
  if (entries !== undefined) {
    pending.push(
      ...entries.map((entry) => {
        return {
          ...entry,
          keys: [...(entry.keys ?? []), ...(reading.keys ?? [])],
        };
      }),
    );
    return true;
  }
  const settled = asyncArrayFactoryViews(reading.value, reading.index, stableSource);
  if (settled !== undefined) {
    pending.push(...settled.map((view) => keyedView(view, reading)));
    return true;
  }
  if (!isCallExpression(reading.value)) return false;
  const copies =
    arrayFactoryViews(reading.value, reading.index, stableSource) ??
    arrayProjectedViews(reading.value, reading.index, stableSource) ??
    arrayCopyViews(reading.value, reading.index, provenSource, stableSource);
  if (copies === undefined) return false;
  pending.push(
    ...copies.map((copy) => {
      return {
        ...copy,
        keys: [...(copy.keys ?? []), ...(reading.keys ?? [])],
      };
    }),
  );
  return true;
}

/** A selected value read on by its keys; a written array read by an index key is followed in. */
function keyedError(
  value: Expression,
  keys: readonly string[] | undefined,
  proof: ElementProof,
  pending: ElementReading[],
): boolean {
  const keyed = literalKeyedReading(value, keys) ?? indexedReading(value, keys);
  if (keyed !== undefined) pending.push(keyed);
  return proof.error(value, keys);
}

/** What the value's written annotation, read by the selected position and keys, says. */
function typedError(value: Expression, reading: ElementReading, proof: ElementProof): boolean {
  return (reading.keys?.length ?? 0) > 0
    ? proof.error(value, [String(reading.index ?? 0), ...(reading.keys ?? [])])
    : proof.typed(value, reading.index);
}

/** A view keeps the member path its reading continues with. */
function keyedView(view: ArrayElementView, reading: ElementReading): ElementReading {
  return { ...view, keys: [...(view.keys ?? []), ...(reading.keys ?? [])] };
}

/** An empty slice or an out-of-range known slot contributes no array element. */
function insideView(reading: ElementReading): boolean {
  const start = reading.start ?? 0;
  if (reading.end !== undefined && reading.end <= start) return false;
  if (reading.index === undefined || reading.index < 0) return true;
  return (
    (reading.start === undefined || reading.index >= start) &&
    (reading.end === undefined || reading.index < reading.end)
  );
}

/** One source reading retains its own bounds, copy time and original lexical nodes. */
function readingError(reading: ElementReading, context: ReadingContext): boolean {
  const packed = mapperRestReadingViews(reading);
  if (packed !== undefined) {
    context.pending.push(...packed);
    return false;
  }
  if (reading.element !== true) return arrayReadingError(reading, context);
  const { value } = reading;
  const { proof, pending } = context;
  const keyed = literalKeyedReading(value, reading.keys);
  if (keyed !== undefined) return literalError(keyed.value, keyed, proof, pending);
  if (proof.error(value, reading.keys)) return true;
  // A named inner array read on by an index key keeps its own elements and writes.
  const indexed = indexedReading(value, reading.keys);
  return indexed !== undefined && arrayReadingError(indexed, context);
}

interface ReadingContext {
  readonly proof: ElementProof;
  readonly pending: ElementReading[];
  readonly read: Node | undefined;
}

/** An array source read at a position, through its views, written annotation, writes and initializer. */
function arrayReadingError(reading: ElementReading, context: ReadingContext): boolean {
  const { value } = reading;
  const { proof, pending, read } = context;
  if (reading.typeOnly === true) return typedError(value, reading, proof);
  if (isArrayLiteralExpression(value)) {
    return literalError(value, reading, proof, pending);
  }
  if (!insideView(reading)) return false;
  // A copy or a mapper the file may give an array of its own answers what no view of the slots says.
  if (
    isCallExpression(value) &&
    (arrayCopyMayBeOverridden(value) || arrayProjectionMayBeOverridden(value))
  )
    return true;
  if (expandCopiedArray({ ...reading, value }, pending)) return false;
  pending.push(...nestedArrayReadings({ ...reading, value }));
  if (typedError(value, reading, proof)) return true;
  if (insertedErrors({ ...reading, value }, reading.capture ?? read, proof, pending)) return true;
  pending.push(
    ...assignedArrays(value, reading.index).map((source) => ({ ...reading, ...source })),
  );
  const initializer = arrayInitializer(value);
  if (initializer !== undefined) pending.push({ ...reading, value: initializer });
  return false;
}
