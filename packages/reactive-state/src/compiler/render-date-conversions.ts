import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  type NewExpression,
  type Node,
  SyntaxKind,
  type TaggedTemplateExpression,
  type TemplateExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedBoundErrorArguments } from './framed-bound-errors.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import {
  framedQuietArrayWords,
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedNativeRaw } from './framed-native-raw.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { LOCAL_TIME } from './local-date-inputs.ts';
import { localDateProjection } from './local-date-projections.ts';
import { localDateInvocation } from './render-date-local-invocations.ts';
import {
  conversionLocalSource,
  dateCoowned,
  dateInputsQuiet,
  dateSource,
  dateStringArguments,
  unknownValue,
  unreadArgument,
  writesWhenEvaluated,
} from './render-date-local-sources.ts';
import { nativeStringConcat, STRING_CONCAT_FIELDS } from './render-date-string-concat.ts';
import { nativeStringPadding, STRING_PADDING_FIELDS } from './render-date-string-padding.ts';
import {
  nativeStringReplacement,
  STRING_REPLACEMENT_FIELDS,
} from './render-date-string-replacement.ts';
import { quietNativeRawTarget, renderDateConversionSource } from './render-date-text.ts';

/** Quiet native String and finite native array text retain source-known Date text inputs. */

const DATES: ReadonlySet<string> = new Set(['Date']);
const STRINGS: ReadonlySet<string> = new Set(['String']);
const ARRAY_TEXT: ReadonlySet<string> = new Set(['join', 'toString']);
const ARRAY_JOIN_PATH = 'Array.prototype.join';
const ARRAY_STRING_PATH = 'Array.prototype.toString';
const BORROWED_TEXT = new Set([ARRAY_JOIN_PATH, ARRAY_STRING_PATH]);
const BORROWED_FIELDS = new Set([
  'Array',
  'Array.prototype',
  'Array.prototype.join.bind',
  'Array.prototype.toString.bind',
  ARRAY_JOIN_PATH,
  ARRAY_STRING_PATH,
  'Date',
  'Reflect',
  'Reflect.apply',
  'String',
  'String.bind',
]);
const ARRAY_JOIN = new Set([ARRAY_JOIN_PATH]);

/** A borrowed native array text call: its receiver, its arguments where read, name and bind. */
interface BorrowedArrayText {
  readonly receiver: Expression;
  readonly given: readonly Expression[] | undefined;
  readonly name: string;
  readonly bound: CallExpression | undefined;
}

/** A native array text call read whole: `join` or `toString`, its receiver, arguments and read. */
interface ArrayText {
  readonly name: string;
  readonly receiver: Expression;
  readonly given: readonly Expression[];
  readonly read: Expression;
}

/** A native String invocation: its target, the inputs it is given, and whether it constructs. */
interface NativeStringCall {
  readonly target: Expression;
  readonly args: readonly Expression[] | undefined;
  readonly constructed: boolean;
}

/** A native array text call whose arguments the compile cannot read whole, as they are written. */
interface UnreadArrayText extends Omit<ArrayText, 'given'> {
  readonly given: readonly Expression[] | undefined;
}

/** Only the added native conversion uses the original consumer's source and earlier-work boundary. */
export function renderDateConversion(node: Node): string | undefined {
  if (isTaggedTemplateExpression(node)) return rawTagDate(node) ? LOCAL_TIME : undefined;
  if (
    isCallExpression(node) &&
    (rawCallDate(node) ||
      invokedArrayDate(node) ||
      concatenatedDate(node) ||
      paddedDate(node) ||
      replacedDate(node))
  )
    return LOCAL_TIME;
  return ordinaryDateConversion(node);
}

/** Native concat evaluates every argument before converting its receiver and given values in order. */
function concatenatedDate(call: CallExpression): boolean {
  return nativeStringConcat(call, {
    coowned: (value) => dateCoowned(value, call),
    inputs: (values) => dateInputsQuiet(values, call, STRING_CONCAT_FIELDS),
    arguments: (values) => dateStringArguments(call, values),
    date: (value) => rawDateSource(value, call),
    quiet: (value) => quietRawSubstitution(value, call) || unknownValue(value),
  });
}

/** Native padding keeps its numeric width separate from consumed Date text in its fill. */
function paddedDate(call: CallExpression): boolean {
  return nativeStringPadding(call, {
    coowned: (value) => dateCoowned(value, call),
    inputs: (values) => dateInputsQuiet(values, call, STRING_PADDING_FIELDS),
    arguments: (values) => dateStringArguments(call, values),
    date: (value) => rawDateSource(value, call),
    quiet: (value) => quietRawSubstitution(value, call),
    unread: (value) => unknownValue(value),
  });
}

/** Native replacement keeps a noncallable replacement's Date text separate from callback creation. */
function replacedDate(call: CallExpression): boolean {
  return nativeStringReplacement(call, {
    coowned: (value) => dateCoowned(value, call),
    inputs: (values) => dateInputsQuiet(values, call, STRING_REPLACEMENT_FIELDS),
    arguments: (values) => dateStringArguments(call, values),
    date: (value) => rawDateSource(value, call),
    quiet: (value) => quietRawSubstitution(value, call),
    unread: (value) => unknownValue(value),
  });
}

/** An immediate local callable keeps both its native body prefix and invocation-time prefix. */
function invokedArrayDate(call: CallExpression): boolean {
  const inner = localDateInvocation(call);
  return (
    inner !== undefined &&
    joinedDate(inner, call) &&
    framedQuietTextPrefix(inner, DATES) &&
    framedQuietTextPrefix(call, DATES)
  );
}

/** Existing ordinary text consumers retain their original admission path. */
function ordinaryDateConversion(node: Node): string | undefined {
  if (isCallExpression(node) && (borrowedArrayDate(node) || borrowedStringDate(node)))
    return LOCAL_TIME;
  if (isBinaryExpression(node))
    return additionArrayDate(node) && framedQuietTextPrefix(node, DATES) ? LOCAL_TIME : undefined;
  if (!isNewExpression(node) && !isCallExpression(node) && !isTemplateExpression(node))
    return undefined;
  const converts = isTemplateExpression(node)
    ? templateArrayDate(node)
    : stringDate(node) || (isCallExpression(node) && joinedDate(node));
  return converts && framedQuietTextPrefix(node, DATES) ? LOCAL_TIME : undefined;
}

/**
 * Native raw tags evaluate every substitution before any substitution becomes text; one of a value
 * of unknown provenance (`unknownValue`) leaves the later ones to become text.
 */
function rawTagDate(node: TaggedTemplateExpression): boolean {
  if (!isTemplateExpression(node.template)) return false;
  const inputs = node.template.templateSpans.map((span) => span.expression);
  if (!rawInputsQuiet(node.tag, inputs, node)) return false;
  for (const value of inputs) {
    if (rawDateSource(value, node)) return true;
    if (!quietRawSubstitution(value, node) && !unknownValue(value)) return false;
  }
  return false;
}

/** Only a finite native array of quiet primitive entries adds a preceding raw coercion. */
function quietRawSubstitution(value: Expression, consumer: Expression): boolean {
  if (framedQuietPrimitive(value)) return true;
  const source = dateSource(value, consumer);
  return (
    source !== undefined &&
    isArrayLiteralExpression(source) &&
    framedQuietArrayWords(source, () => false, consumer)
  );
}

/** Written raw segment counts reuse native raw's existing consumed-substitution selection. */
function rawCallDate(node: CallExpression): boolean {
  return (
    rawInputsQuiet(node.expression, node.arguments, node) &&
    framedNativeRaw(node, node.arguments, {
      error: (value) => rawDateSource(value, node),
      typed: () => false,
    })
  );
}

/** Scalar Dates and finite native Date arrays share the existing native text-origin proof. */
function rawDateSource(value: Expression, consumer: Expression): boolean {
  return renderDateConversionSource(value, consumer) || arrayDateSource(value, consumer);
}

/** Original native targets, all input evaluations and the earlier owner prefix remain quiet. */
function rawInputsQuiet(
  target: Expression,
  inputs: readonly Expression[],
  consumer: Expression,
): boolean {
  return (
    quietNativeRawTarget(target, consumer, dateCoowned) &&
    inputs.every((value) => dateCoowned(value, consumer)) &&
    dateInputsQuiet(inputs, consumer, DATES)
  );
}

/**
 * Borrowed native String converts its first consumed input, independently of the ignored supplied
 * receiver and of the inputs after it, but for one whose evaluation writes as the code shows
 * (`writesWhenEvaluated`); a `call` whose receiver and first input are written before any spread
 * reads that input whatever the spread holds (`writtenStringCall`).
 */
function borrowedStringDate(call: CallExpression): boolean {
  const bound = framedBoundErrorArguments(call, STRINGS);
  const selected = bound ?? framedNativeArguments(call, STRINGS) ?? writtenStringCall(call);
  if (
    selected === undefined ||
    selected.constructed ||
    selected.args === undefined ||
    (bound === undefined && framedNativeConstructor(call.expression, STRINGS))
  )
    return false;
  if (!borrowedInputsQuiet(call, selected.target, bound?.bound)) return false;
  const head = framedArgumentPrefix(call, selected.args, 1);
  if (head.unknown || head.alternatives !== undefined) return false;
  const [first] = head.values;
  const read = bound?.bound ?? call;
  return (
    first !== undefined &&
    selected.args.slice(1).every((argument) => !writesWhenEvaluated(argument)) &&
    dateCoowned(first, call) &&
    (renderDateConversionSource(first, read) || arrayDateSource(first, read))
  );
}

/** A `call` of the native String whose receiver and first input are written before any spread. */
function writtenStringCall(call: CallExpression): NativeStringCall | undefined {
  const callee = unwrapped(call.expression);
  if (
    (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) ||
    frameMemberName(callee) !== 'call' ||
    !framedNativeConstructor(callee.expression, STRINGS)
  )
    return undefined;
  const [receiver, first] = call.arguments;
  if ([receiver, first].some((value) => value === undefined || isSpreadElement(value)))
    return undefined;
  return { target: callee.expression, args: call.arguments.slice(1), constructed: false };
}

/** Every original wrapper input remains coowned and quiet before native text conversion. */
function borrowedInputsQuiet(
  call: CallExpression,
  target: Expression,
  bound: CallExpression | undefined,
): boolean {
  const inputs = [...call.arguments, ...(bound?.arguments ?? [])];
  return (
    dateCoowned(call.expression, call) &&
    dateCoowned(target, call) &&
    inputs.every((input) => dateCoowned(input, call)) &&
    dateInputsQuiet(inputs, call, BORROWED_FIELDS) &&
    framedQuietTextPrefix(call, BORROWED_FIELDS, (prior) => prior === bound)
  );
}

/**
 * A borrowed native array conversion keeps its original receiver and earlier-work guard; what it is
 * given the compile cannot read, or carried across an execution owner, may be any value
 * (`unreadArrayText`), and inputs the compile reads must evaluate quietly.
 */
function borrowedArrayDate(call: CallExpression): boolean {
  const selected = borrowedArrayText(call);
  if (selected === undefined) return false;
  const inputs = [...call.arguments, ...(selected.bound?.arguments ?? [])];
  if (
    !dateCoowned(call.expression, call) ||
    !dateCoowned(selected.receiver, call) ||
    !framedQuietTextPrefix(call, BORROWED_FIELDS, (prior) => prior === selected.bound)
  )
    return false;
  const read = selected.bound ?? call;
  const prefix =
    selected.given === undefined ? undefined : framedArgumentPrefix(call, selected.given, Infinity);
  if (
    prefix === undefined ||
    prefix.unknown ||
    prefix.alternatives !== undefined ||
    inputs.some((input) => !dateCoowned(input, call))
  ) {
    const { name, receiver, given } = selected;
    return unreadArrayText(call, { name, receiver, given, read });
  }
  if (!dateInputsQuiet(inputs, call, BORROWED_FIELDS)) return false;
  const text = { name: selected.name, receiver: selected.receiver, given: prefix.values, read };
  return arrayText(call, text);
}

/** Existing native borrowing and bind normalization retain the receiver outside consumed arguments. */
function borrowedArrayText(call: CallExpression): BorrowedArrayText | undefined {
  const bound = framedBoundErrorArguments(call, BORROWED_TEXT);
  if (bound !== undefined) {
    const prefix = framedArgumentPrefix(bound.bound, bound.bound.arguments, Infinity);
    const receiver = prefix.values[0];
    if (receiver === undefined || prefix.unknown || prefix.alternatives !== undefined)
      return undefined;
    return {
      receiver,
      given: bound.args,
      name: framedNativeConstructor(bound.target, ARRAY_JOIN) ? 'join' : 'toString',
      bound: bound.bound,
    };
  }
  const borrowed = borrowedTextCall(call);
  if (borrowed === undefined || !BORROWED_TEXT.has(borrowed.path.join('.'))) return undefined;
  const applied = borrowed.applied;
  const reflected = globalPathOf(unwrapped(call.expression))?.join('.') === 'Reflect.apply';
  if (reflected && (applied === undefined || nullishArrayArguments(applied))) return undefined;
  const given =
    applied === undefined || nullishArrayArguments(applied)
      ? borrowed.given
      : framedAppliedArguments(call, applied);
  return { receiver: borrowed.receiver, given, name: borrowed.path.at(-1) ?? '', bound: undefined };
}

/** Function.apply accepts an omitted or native nullish list; Reflect.apply requires an object list. */
function nullishArrayArguments(expression: Expression): boolean {
  const value = framedQuietSource(expression);
  return (
    value !== undefined &&
    (value.kind === SyntaxKind.NullKeyword || globalPathOf(value)?.join('.') === 'undefined')
  );
}

/**
 * Both addition operands evaluate before coercion; a quiet primitive, or a value of unknown
 * provenance (`unknownValue`), which may be any value, accompanies the array, whose elements become
 * text.
 */
function additionArrayDate(node: BinaryExpression): boolean {
  const operation = node.operatorToken.kind;
  if (operation !== SyntaxKind.PlusToken && operation !== SyntaxKind.PlusEqualsToken) return false;
  const left =
    conversionLocalSource(node.left, node) ??
    (operation === SyntaxKind.PlusToken || unknownValue(node.left) ? node.left : undefined);
  if (left === undefined) return false;
  const right = conversionLocalSource(node.right, node) ?? node.right;
  return (
    (accompanying(left) && dateCoowned(right, node) && arrayDateSource(right, node)) ||
    (accompanying(right) && dateCoowned(left, node) && arrayDateSource(left, node))
  );
}

/** Whether a value beside a converted array leaves its elements to become text (`unknownValue`). */
function accompanying(value: Expression): boolean {
  return framedQuietPrimitive(value) || unknownValue(value);
}

/**
 * Untagged substitutions become text in order; an earlier conversion the code writes and the
 * compile cannot prove quiet retains opacity, but one of a value of unknown provenance
 * (`unknownValue`), which may be any value, leaves the later substitutions to become text.
 */
function templateArrayDate(node: TemplateExpression): boolean {
  if (isTaggedTemplateExpression(node.parent)) return false;
  for (const span of node.templateSpans) {
    if (dateCoowned(span.expression, node) && arrayDateSource(span.expression, node)) return true;
    if (!framedQuietPrimitive(span.expression) && !unknownValue(span.expression)) return false;
  }
  return false;
}

/**
 * Every original String argument evaluates before its selected first input becomes text. String
 * reads none after it, so a first argument written there decides whatever follows it, but for one
 * whose evaluation writes as the code shows (`writesWhenEvaluated`), which may rewrite the first;
 * one a spread gives decides where the compile reads the spread whole and quietly.
 */
function stringDate(node: CallExpression | NewExpression): boolean {
  if (!framedNativeConstructor(node.expression, STRINGS) || !dateCoowned(node.expression, node))
    return false;
  const given = node.arguments ?? [];
  const [written] = given;
  if (written !== undefined && !isSpreadElement(written))
    return (
      given.slice(1).every((value) => !writesWhenEvaluated(value)) && stringDateInput(written, node)
    );
  const values = dateStringArguments(node, given);
  if (
    values === undefined ||
    given.some((value) => !dateCoowned(value, node)) ||
    !dateInputsQuiet(given, node, DATES)
  )
    return false;
  const [first] = values;
  return first !== undefined && stringDateInput(first, node);
}

/** Whether String's first input is Date text: a whole Date, or a finite native array of Dates. */
function stringDateInput(first: Expression, node: CallExpression | NewExpression): boolean {
  return (
    dateCoowned(first, node) &&
    (renderDateConversionSource(first, node) || arrayDateSource(first, node))
  );
}

/**
 * Native join and toString retain Date text only before own method, element or iterator exposure.
 * A spread the compile cannot read, or one carried across an execution owner, gives what may be any
 * value (`unreadArrayText`); a spread it reads must evaluate quietly.
 */
function joinedDate(node: CallExpression, read: Expression = node): boolean {
  const method = node.expression;
  if (!isPropertyAccessExpression(method) && !isElementAccessExpression(method)) return false;
  const name = frameMemberName(method) ?? '';
  if (!ARRAY_TEXT.has(name) || !dateCoowned(method.expression, read)) return false;
  const given = dateStringArguments(node, node.arguments);
  const spread = node.arguments.some((argument) => isSpreadElement(argument));
  if (given === undefined || (spread && node.arguments.some((value) => !dateCoowned(value, read))))
    return unreadArrayText(node, {
      name,
      receiver: method.expression,
      given: node.arguments,
      read,
    });
  if (spread && !dateInputsQuiet(node.arguments, read, DATES)) return false;
  return arrayText(node, { name, receiver: method.expression, given, read });
}

/**
 * Whether a native array text call the compile reads the arguments of renders Date text. The
 * elements render whatever the arguments are, so their Date text is read first, and no argument
 * takes it away — but one whose evaluation writes, as the code shows (`writesWhenEvaluated`), may
 * rewrite them first: `toString` reads no argument, and a join's separator at most adds Date text —
 * one the compile cannot read (`unreadArgument`) may be any value, a Date among them, and one that
 * is a Date's text renders it (`joinedDateSeparator`).
 */
function arrayText(node: CallExpression, text: ArrayText): boolean {
  const { name, receiver, given, read } = text;
  if (given.every((value) => !writesWhenEvaluated(value)) && arrayDateSource(receiver, read))
    return true;
  const [separator] = given;
  if (name !== 'join' || separator === undefined) return false;
  if (unreadArgument(separator, read)) return nativeArray(receiver, read);
  return joinedDateSeparator(node, receiver, given, read);
}

/**
 * What a native array text call renders where the compile cannot read all it is given: `toString`
 * reads no argument, and the elements decide; a join reads its first argument alone, so a separator
 * written before any spread is read as written (`arrayText`), and one a spread the compile cannot
 * read may give may be any value, a Date among them, which the native join of an array converts.
 */
function unreadArrayText(node: CallExpression, text: UnreadArrayText): boolean {
  const { name, receiver, given, read } = text;
  const [first] = given ?? [];
  if (name !== 'join' || (given !== undefined && (first === undefined || !isSpreadElement(first))))
    return arrayText(node, { name, receiver, given: first === undefined ? [] : [first], read });
  return nativeArray(receiver, read);
}

/** Whether a receiver is a native finite array, whose native join converts its separator first. */
function nativeArray(receiver: Expression, read: Expression): boolean {
  const source = dateSource(receiver, read);
  return source !== undefined && isArrayLiteralExpression(source);
}

/** A native join separator becomes text before any elements, including empty or single arrays. */
function joinedDateSeparator(
  node: CallExpression,
  receiver: Expression,
  given: readonly Expression[] = node.arguments,
  read: Expression = node,
): boolean {
  const [separator, ...remaining] = given;
  const source = dateSource(receiver, read);
  return (
    separator !== undefined &&
    source !== undefined &&
    isArrayLiteralExpression(source) &&
    framedQuietInputs([source], DATES) &&
    remaining.every((argument) => framedQuietPrimitive(argument)) &&
    dateCoowned(separator, read) &&
    (renderDateConversionSource(separator, read) || arrayDateSource(separator, read))
  );
}

/** A native array conversion follows only an unchanged finite literal source. */
function arrayDateSource(value: Expression, consumer: Expression): boolean {
  const source = dateSource(value, consumer);
  return source !== undefined && isArrayLiteralExpression(source) && arrayDates(source, consumer);
}

/** Every earlier element conversion is quiet; no unknown toString can replace a later Date's words. */
function arrayDates(array: Expression, consumer: Expression): boolean {
  let dated = false;
  const pending = [array];
  const seen = new Set<Expression>();
  for (let expression = pending.pop(); expression !== undefined; expression = pending.pop()) {
    const value = framedQuietSource(expression);
    if (value === undefined) return false;
    if (seen.has(value)) continue;
    seen.add(value);
    if (isArrayLiteralExpression(value)) pending.push(...value.elements);
    else if (isSpreadElement(value)) {
      const spread = framedQuietSource(value.expression);
      if (spread === undefined || !isArrayLiteralExpression(spread)) return false;
      pending.push(spread);
    } else if (isOmittedExpression(value) || framedQuietPrimitive(value)) continue;
    else if (renderDateConversionSource(expression, consumer)) dated = true;
    else if (!quietDate(expression, consumer)) return false;
  }
  return dated;
}

/** Invalid native Dates add fixed text; a quiet native construction still cannot replace another Date. */
function quietDate(value: Expression, read: Expression): boolean {
  return localDateProjection(value, [], (source) => framedQuietInputs([source], DATES), {
    read,
    whole: true,
  });
}
