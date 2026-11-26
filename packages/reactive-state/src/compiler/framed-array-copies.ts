import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBigIntLiteral,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type ObjectLiteralElementLike,
  type SpreadElement,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { framedWrittenArray } from './framed-array-factories.ts';
import { flattenedArrayViews } from './framed-array-flatten.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { splicedArrayViews } from './framed-array-spliced.ts';
import { arrayMethodMayBeOverridden } from './framed-arrays.ts';
import { frameMemberName } from './framed-bindings.ts';
import { concatQuietArguments } from './framed-concat-properties.ts';
import { framedConcatSegment } from './framed-concat-spreads.ts';
import { framedDeclaredElements } from './framed-copied-inputs.ts';
import { filteredArrayViews } from './framed-filter-results.ts';
import { expandedFlatViews } from './framed-flat-depth-results.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { removedArrayViews } from './framed-splice-results.ts';
import { constantValue } from './numbers.ts';

/** Native shallow copies retain source element identity before a later numeric selection. */

const COPIES = new Set([
  'concat',
  'filter',
  'flat',
  'slice',
  'splice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'with',
]);
const COPY_WRAPPER = { reflect: 3 } as const;

interface CopyCall {
  readonly call: CallExpression;
  readonly wrapperTail: readonly Expression[];
  /** The argument list an `apply` or `Reflect.apply` hands the native, as written. */
  readonly applied?: Expression | undefined;
  readonly receiver: Expression;
  readonly method: string;
  readonly given: readonly Expression[];
  readonly borrowed: boolean;
  readonly unknownArguments?: boolean;
}

/**
 * Known array-copy methods preserve selected source slots and their copy-time mutation boundary.
 * `stable` proves a receiver unchanged at the copy; `proven`, for concat's quiet slots, whose proof an
 * exposure drops, may count fewer earlier uses. A method that the file may give an array of its own
 * is read as the language's here: a reader of the answer asks `arrayCopyMayBeOverridden` first.
 */
export function arrayCopyViews(
  call: CallExpression,
  index: number | undefined,
  proven: (receiver: Expression) => boolean,
  stable: (receiver: Expression) => boolean = proven,
): readonly ArrayElementView[] | undefined {
  const selected = copyCall(call);
  if (selected === undefined) return undefined;
  if (!selected.borrowed && sourceArrayFunction(call.expression)) return undefined;
  if (selected.method === 'toSpliced') return nativeSplicedViews(call, selected, index, stable);
  if (selected.method === 'splice')
    return (
      removedArrayViews(selected, index, stable) ?? [
        { value: selected.receiver, index: undefined },
        { value: selected.receiver, index: undefined, typeOnly: true },
      ]
    );
  if (selected.method === 'flat')
    return (
      expandedFlatViews(selected, index, stable) ??
      flattenedArrayViews(selected.receiver, index, fallbackDepth(call, selected.given), {
        stable,
        capture: call,
      })
    );
  const at = index !== undefined && index < 0 ? undefined : index;
  const position = stable(selected.receiver) ? at : undefined;
  const views = nativeCopies(selected, position, stable, proven);
  return views.map((view) => ({ ...view, capture: call }));
}

/**
 * Whether the call is a native array copy named at an array the file may give a method of that name
 * of its own: what it answers is then no copy of the array's slots, and a reader of the answer
 * refuses. A borrowed call runs the native method whatever the array holds.
 */
export function arrayCopyMayBeOverridden(call: CallExpression): boolean {
  const selected = copyCall(call);
  return (
    selected !== undefined &&
    !selected.borrowed &&
    arrayMethodMayBeOverridden(call, selected.method)
  );
}

/**
 * A complete argument list at exact positions (`exactArguments`) lets native toSpliced map each
 * retained and inserted result.
 */
function nativeSplicedViews(
  call: CallExpression,
  selected: CopyCall,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
): readonly ArrayElementView[] | undefined {
  if (selected.unknownArguments === true)
    return [
      { value: selected.receiver, index: undefined, capture: call },
      ...appliedViews(selected),
    ];
  const lengths = argumentLengths(selected);
  const args = exactArguments(selected, lengths, Infinity);
  if (args.unknown) return unknownSplicedViews(call, selected, lengths);
  const stableReceiver = stable(selected.receiver);
  const views = splicedArrayViews(selected.receiver, args.values, index, stableReceiver);
  return views.map((view) => ({ ...view, capture: call }));
}

/** Direct and known borrowed methods share receiver semantics; borrowed calls ignore own overrides. */
function copyCall(call: CallExpression): CopyCall | undefined {
  const borrowed = borrowedTextCall(call);
  if (borrowed?.path.slice(0, -1).join('.') === 'Array.prototype') {
    const method = borrowed.path.at(-1) ?? '';
    if (!COPIES.has(method)) return undefined;
    const given =
      borrowed.applied === undefined
        ? borrowed.given
        : framedAppliedArguments(call, borrowed.applied);
    return {
      call,
      wrapperTail: copyWrapperTail(call),
      applied: borrowed.applied,
      receiver: borrowed.receiver,
      method,
      given: given ?? [],
      borrowed: true,
      unknownArguments: given === undefined,
    };
  }
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const method = frameMemberName(member);
  return method !== undefined && COPIES.has(method)
    ? {
        call,
        wrapperTail: [],
        receiver: member.expression,
        method,
        given: call.arguments,
        borrowed: false,
      }
    : undefined;
}

/** Ignored apply wrapper arguments still run before the native target copies its slots. */
function copyWrapperTail(call: CallExpression): readonly Expression[] {
  const member = unwrapped(call.expression);
  if (globalPathOf(member)?.join('.') === 'Reflect.apply')
    return call.arguments.slice(COPY_WRAPPER.reflect);
  return (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    frameMemberName(member) === 'apply'
    ? call.arguments.slice(2)
    : [];
}

/** Each supported native copy either preserves a range or replaces selected positions explicitly. */
function nativeCopies(
  copy: CopyCall,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
  proven: (receiver: Expression) => boolean,
): readonly ArrayElementView[] {
  const base = { value: copy.receiver, index };
  switch (copy.method) {
    case 'slice': {
      return sliced(copy.receiver, copy.given, index);
    }
    case 'concat': {
      return nativeConcatenated(copy, index, proven);
    }
    case 'filter': {
      return filteredArrayViews(copy, index, stable);
    }
    case 'toReversed': {
      const length = literalLength(copy.receiver);
      if (length !== undefined && index !== undefined && index >= length) return [];
      return [
        {
          ...base,
          index: index === undefined || length === undefined ? undefined : length - 1 - index,
        },
      ];
    }
    case 'with': {
      return replaced(copy, index);
    }
    default: {
      return [{ ...base, index: undefined }];
    }
  }
}

/** The arguments that set what toSpliced removes, start and deleteCount, before any it inserts. */
const SPLICE_RANGE = 2;

/**
 * A toSpliced whose arguments the compile cannot read may put any receiver element or inserted
 * item at the position: a spread's elements followed under the receiver's declared element type
 * (`copied`), and each other argument, but one at the range's positions where positions are exact
 * (`argumentLengths`): the native converts it to a number, never inserts it, and what converting it
 * may run is the effect checks' to read.
 */
function unknownSplicedViews(
  call: CallExpression,
  selected: CopyCall,
  lengths: ArgumentLengths | undefined,
): readonly ArrayElementView[] {
  const copied = receiverCopied(selected.receiver, true);
  const inserted: ArrayElementView[] = [];
  let position = lengths === undefined ? undefined : 0;
  for (const [at, each] of selected.given.entries()) {
    if (isSpreadElement(each))
      inserted.push({ value: each.expression, index: undefined, capture: call, copied });
    else if (position === undefined || position >= SPLICE_RANGE)
      inserted.push({ value: each, index: undefined, element: true, capture: call });
    const length = lengths?.[at];
    position = position === undefined || length === undefined ? undefined : position + length;
  }
  return [{ value: selected.receiver, index: undefined, capture: call }, ...inserted];
}

/** How many arguments each of a copy's arguments supplies, where known (`argumentLengths`). */
type ArgumentLengths = readonly (number | undefined)[];

/**
 * How many arguments each of a copy's arguments supplies its native, where positions are exact: one
 * each, a spread of a pure array literal its length (`pureLength`), and any other spread a count
 * the compile does not know, from which on no position is exact. None at all where anything the
 * call evaluates before the native reads its arguments may run code (`pure`): the receiver, the
 * list an `apply` or `Reflect.apply` hands it, the wrapper's tail, or an argument before that
 * spread, `(args.push(0), 0), ...args`. Each argument is read once, however deep spreads nest.
 * A call of written arguments alone, no spread and no `apply` list, has exact positions whatever
 * runs before it: code there cannot change how many arguments it writes.
 */
function argumentLengths(copy: CopyCall): ArgumentLengths | undefined {
  if (copy.applied === undefined && copy.given.every((each) => !isSpreadElement(each)))
    return copy.given.map(() => 1);
  const evaluated = [copy.receiver, ...(copy.applied === undefined ? [] : [copy.applied])];
  if ([...evaluated, ...copy.wrapperTail].some((each) => !pure(each))) return undefined;
  const lengths: (number | undefined)[] = [];
  let open = false;
  for (const each of copy.given) {
    if (isSpreadElement(each)) {
      const length: number | undefined = open ? undefined : pureLength(each.expression);
      open ||= length === undefined;
      lengths.push(length);
    } else if (open || pure(each)) lengths.push(1);
    else return undefined;
  }
  return lengths;
}

/**
 * The arguments a copy's native reads at exact positions, up to `limit` (`argumentLengths`): those
 * before the first spread whose count the compile does not know, each pure literal's spread
 * expanded (`framedArgumentPrefix`), and unknown past them; none where no position is exact.
 */
function exactArguments(
  copy: CopyCall,
  lengths: ArgumentLengths | undefined,
  limit: number,
): ReturnType<typeof framedArgumentPrefix> {
  if (lengths === undefined) return { values: [], unknown: true };
  const end = lengths.indexOf(undefined);
  const given = end === -1 ? copy.given : copy.given.slice(0, end);
  const args = framedArgumentPrefix(copy.call, given, limit);
  return end === -1 || args.values.length >= limit ? args : { ...args, unknown: true };
}

/** The literals whose evaluation runs no code. */
const PURE_LITERALS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TrueKeyword,
]);

/**
 * Whether evaluating a value runs no code, as its syntax alone shows: a literal, a signed number, a
 * name, an array literal written in place that is pure (`pureLength`), or an object literal each
 * member of which is a written key holding a pure value, a name, or a method or an accessor, which
 * runs nothing as the literal is made; each past `as`, `satisfies`, `!` and parentheses. No call,
 * member read, comma, assignment, `void` or other operator.
 */
function pure(node: Expression): boolean {
  const value = unwrapped(node);
  if (PURE_LITERALS.has(value.kind) || isIdentifier(value) || signedNumber(value)) return true;
  if (isObjectLiteralExpression(value)) return value.properties.every((each) => pureMember(each));
  return pureLength(value) !== undefined;
}

/** A number or a bigint literal under a sign, `-1`. */
function signedNumber(value: Expression): boolean {
  return (
    isPrefixUnaryExpression(value) &&
    (value.operator === SyntaxKind.MinusToken || value.operator === SyntaxKind.PlusToken) &&
    (isNumericLiteral(value.operand) || isBigIntLiteral(value.operand))
  );
}

/** Whether an object literal's member runs no code as the literal is made (`pure`). */
function pureMember(member: ObjectLiteralElementLike): boolean {
  if (isShorthandPropertyAssignment(member))
    return member.objectAssignmentInitializer === undefined;
  if (isSpreadAssignment(member) || isComputedPropertyName(member.name)) return false;
  return !isPropertyAssignment(member) || pure(member.initializer);
}

/**
 * How many arguments spreading an array literal written in place supplies, where it is pure: one
 * for each element that is a pure value (`pure`) or a hole, and its own length for each spread of
 * such a literal. None of anything else.
 */
function pureLength(node: Expression): number | undefined {
  const array = unwrapped(node);
  if (!isArrayLiteralExpression(array)) return undefined;
  let length = 0;
  for (const element of array.elements) {
    let each: number | undefined;
    if (isSpreadElement(element)) each = pureLength(element.expression);
    else each = isOmittedExpression(element) || pure(element) ? 1 : undefined;
    if (each === undefined) return undefined;
    length += each;
  }
  return length;
}

/**
 * What a copy appends from an unresolved spread, under the receiver's declared element type, the
 * spread's elements themselves where `own`.
 */
function receiverCopied(
  receiver: Expression,
  own: boolean,
): {
  readonly declared: TypeNode | undefined;
  readonly follow: boolean;
  readonly depth: number;
  readonly own: boolean;
} {
  return { declared: framedDeclaredElements(receiver), follow: true, depth: 0, own };
}

/** Literal lengths constrain offsets only when no spread can change the position count. */
function literalLength(value: Expression): number | undefined {
  const array = unwrapped(value);
  return isArrayLiteralExpression(array) && !array.elements.some((each) => isSpreadElement(each))
    ? array.elements.length
    : undefined;
}

/** Written primitive numbers supply copy bounds without executing application conversions. */
function bound(value: Expression | undefined, fallback: number | undefined): number | undefined {
  if (value === undefined) return fallback;
  const constant = constantValue(unwrapped(value));
  return constant === undefined ? undefined : Math.trunc(Number(constant)) || 0;
}

/** Known slice bounds exclude untouched prefixes and suffixes while opaque offsets retain all elements. */
function sliced(
  receiver: Expression,
  given: readonly Expression[],
  index: number | undefined,
): readonly ArrayElementView[] {
  const length = literalLength(receiver);
  let start = bound(given[0], 0);
  let end = bound(given[1], length);
  if (start !== undefined && start < 0)
    start = length === undefined ? undefined : Math.max(length + start, 0);
  if (end !== undefined && end < 0)
    end = length === undefined ? undefined : Math.max(length + end, 0);
  return [
    {
      value: receiver,
      index: start === undefined || index === undefined ? undefined : start + index,
      start,
      end,
    },
  ];
}

/**
 * All evaluated arguments must keep an earlier array-like source unchanged before native copying;
 * source-known argument spreads expand first, an unresolved one keeping the written list and what
 * it may supply in an unknown order (the prefix's alternatives) as further arguments.
 */
function nativeConcatenated(
  copy: CopyCall,
  index: number | undefined,
  stable: (value: Expression) => boolean,
): readonly ArrayElementView[] {
  const args = framedArgumentPrefix(copy.call, copy.given, Infinity);
  const given =
    args.unknown || args.alternatives !== undefined
      ? [...copy.given, ...(args.alternatives ?? [])]
      : args.values;
  const quiet =
    copy.unknownArguments !== true &&
    concatQuietArguments([copy.receiver, ...given, ...copy.wrapperTail], stable);
  const unresolved = args.unknown && args.alternatives === undefined;
  return concatenated({ ...copy, given }, index, (value) => quiet && stable(value), unresolved);
}

/**
 * An unresolved spread among concat's arguments supplies each element of its source as an
 * argument, an array among them spread in turn: each element is possible, and so is each element
 * of a written one, followed under the receiver's declared element type (`copied`).
 */
function unresolvedSpreadViews(
  spread: SpreadElement,
  receiver: Expression,
  capture: CallExpression,
): readonly ArrayElementView[] {
  const copied = receiverCopied(receiver, false);
  const views: ArrayElementView[] = [
    { value: spread.expression, index: undefined, capture, copied },
  ];
  const written = framedWrittenArray(spread.expression);
  if (written === undefined) return views;
  for (const element of written.elements) {
    if (isOmittedExpression(element)) continue;
    const value = isSpreadElement(element) ? element.expression : element;
    views.push({ value, index: undefined, capture, copied });
  }
  return views;
}

/** A literal concatenation keeps its runtime segment boundaries; unknown lengths keep every segment. */
function concatenated(
  copy: CopyCall,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
  unresolved: boolean,
): readonly ArrayElementView[] {
  const sources = [
    { value: copy.receiver, receiver: true },
    ...copy.given.map((value) => ({ value, receiver: false })),
  ];
  const views: ArrayElementView[] = [];
  let position = index;
  for (const source of sources) {
    const { value } = source;
    const segment =
      unresolved && isSpreadElement(value)
        ? { length: undefined, views: unresolvedSpreadViews(value, copy.receiver, copy.call) }
        : concatSourceViews(value, source.receiver, position, { stable, capture: copy.call });
    const { length } = segment;
    if (position !== undefined && length !== undefined && position >= length) {
      position -= length;
      continue;
    }
    views.push(...segment.views);
    if (position !== undefined && length !== undefined) break;
    position = undefined;
  }
  return views;
}

/** A known array-like hook adds its slots; other sources retain the existing native array fallback. */
function concatSourceViews(
  value: Expression,
  receiver: boolean,
  index: number | undefined,
  context: { readonly stable: (value: Expression) => boolean; readonly capture: CallExpression },
): { readonly length: number | undefined; readonly views: readonly ArrayElementView[] } {
  const spread = framedConcatSegment(value, index, context.stable, context.capture);
  if (spread !== undefined) return spread;
  const length = literalLength(value);
  const views: ArrayElementView[] = [{ value, index: length === undefined ? undefined : index }];
  if (!receiver && !isArrayLiteralExpression(unwrapped(value)))
    views.push({ value, index: undefined, element: true });
  return { length, views };
}

/**
 * Array.with replaces exactly one known slot; unknown positions preserve source and replacement.
 * Its arguments stand where written only at exact positions (`exactArguments`).
 */
function replaced(copy: CopyCall, index: number | undefined): readonly ArrayElementView[] {
  const lengths = argumentLengths(copy);
  const args = exactArguments(copy, lengths, 2);
  const replacements = replacementViews(copy, args, lengths);
  const length = literalLength(copy.receiver);
  let position = args.alternatives === undefined ? bound(args.values[0], undefined) : undefined;
  if (position !== undefined && position < 0)
    position = length === undefined ? undefined : length + position;
  const source = { value: copy.receiver, index };
  if (copy.unknownArguments === true) return [source, ...appliedViews(copy)];
  if (replacements.length === 0 && (args.unknown || args.alternatives !== undefined))
    return [source];
  if (position !== undefined && index !== undefined && position !== index) return [source];
  return position !== undefined && index === position ? replacements : [source, ...replacements];
}

/**
 * What an `apply` or `Reflect.apply` list the compile cannot read may hand the native: any of its
 * elements, as an unresolved spread supplies them, followed under the receiver's declared element
 * type (`copied`); none where no list is written.
 */
function appliedViews(copy: CopyCall): readonly ArrayElementView[] {
  if (copy.applied === undefined) return [];
  const copied = receiverCopied(copy.receiver, true);
  return [{ value: copy.applied, index: undefined, capture: copy.call, copied }];
}

/** The position of `with`'s value, after its index. */
const WITH_VALUE = 1;

/**
 * The written replacement at an exact position, or each value a spread may supply, and each
 * argument past exact positions (`argumentLengths`) that may stand at the value's position: one
 * that holds no later position than the value's at the least, counting one for each argument
 * before it, its length for each spread at an exact position, and none for any other spread. One
 * past it, a later argument still, is ignored. Exact arguments expand only pure literals, which
 * leave no alternatives (`exactArguments`).
 */
function replacementViews(
  copy: CopyCall,
  args: ReturnType<typeof framedArgumentPrefix>,
  lengths: ArgumentLengths | undefined,
): readonly ArrayElementView[] {
  const replacement = args.values[1];
  if (replacement !== undefined) return [{ value: replacement, index: undefined, element: true }];
  if (!args.unknown) return [];
  const copied = receiverCopied(copy.receiver, true);
  const views: ArrayElementView[] = [];
  let least = 0;
  let open = lengths === undefined;
  for (const [at, each] of copy.given.entries()) {
    if (isSpreadElement(each)) {
      views.push({ value: each.expression, index: undefined, copied });
      const length = open ? undefined : lengths?.[at];
      if (length === undefined) open = true;
      else least += length;
      continue;
    }
    if (open && least <= WITH_VALUE) views.push({ value: each, index: undefined, element: true });
    least += 1;
  }
  return views;
}

/**
 * The depth a flat the reader could not expand reads: every depth where an unresolved spread
 * supplies it, which no written tuple holds; otherwise as written (`flatDepth`).
 */
function fallbackDepth(call: CallExpression, given: readonly Expression[]): number | undefined {
  const args = framedArgumentPrefix(call, given, 1);
  return args.unknown && args.alternatives === undefined ? undefined : flatDepth(given[0]);
}

/** Omitted depth is one; fixed primitive numeric conversions retain zero and unbounded depths. */
function flatDepth(argument: Expression | undefined): number {
  if (argument === undefined) return 1;
  const value = unwrapped(argument);
  if (globalPathOf(value)?.join('.') === 'undefined') return 1;
  if (value.kind === SyntaxKind.NullKeyword || value.kind === SyntaxKind.FalseKeyword) return 0;
  if (value.kind === SyntaxKind.TrueKeyword) return 1;
  const fixed = constantValue(value);
  return fixed === undefined ? Infinity : Math.max(Math.trunc(Number(fixed)) || 0, 0);
}
