import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
  SyntaxKind,
  type TaggedTemplateExpression,
  type TemplateExpression,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedBoundErrorArguments } from './framed-bound-errors.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import {
  framedQuietArrayWords,
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedNativeRaw } from './framed-native-raw.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { LOCAL_TIME } from './local-date-inputs.ts';
import { localDateProjection } from './local-date-projections.ts';
import { localDateInvocation } from './render-date-local-invocations.ts';
import { nativeStringConcat, STRING_CONCAT_FIELDS } from './render-date-string-concat.ts';
import { nativeStringPadding, STRING_PADDING_FIELDS } from './render-date-string-padding.ts';
import {
  nativeStringReplacement,
  STRING_REPLACEMENT_FIELDS,
} from './render-date-string-replacement.ts';
import { quietNativeRawTarget, renderDateConversionSource } from './render-date-text.ts';
import { bindingIdentifiers, hoistedIn, isBlockScoped } from './scope.ts';

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

interface BorrowedArrayText {
  readonly receiver: Expression;
  readonly given: readonly Expression[];
  readonly name: string;
  readonly bound: CallExpression | undefined;
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
    quiet: (value) => quietRawSubstitution(value, call),
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

/** Native raw tags evaluate every substitution before any substitution becomes text. */
function rawTagDate(node: TaggedTemplateExpression): boolean {
  if (!isTemplateExpression(node.template)) return false;
  const inputs = node.template.templateSpans.map((span) => span.expression);
  if (!rawInputsQuiet(node.tag, inputs, node)) return false;
  for (const value of inputs) {
    if (rawDateSource(value, node)) return true;
    if (!quietRawSubstitution(value, node)) return false;
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

/** Borrowed native String converts its consumed input, independently of the ignored supplied receiver. */
function borrowedStringDate(call: CallExpression): boolean {
  const bound = framedBoundErrorArguments(call, STRINGS);
  const selected = bound ?? framedNativeArguments(call, STRINGS);
  if (
    selected === undefined ||
    selected.constructed ||
    selected.args === undefined ||
    (bound === undefined && framedNativeConstructor(call.expression, STRINGS))
  )
    return false;
  if (!borrowedInputsQuiet(call, selected.target, bound?.bound)) return false;
  const prefix = framedArgumentPrefix(call, selected.args, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return false;
  const [first, ...remaining] = prefix.values;
  const read = bound?.bound ?? call;
  return (
    first !== undefined &&
    remaining.every((argument) => framedQuietPrimitive(argument)) &&
    dateCoowned(first, call) &&
    (renderDateConversionSource(first, read) || arrayDateSource(first, read))
  );
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

/** A borrowed native array conversion keeps its original receiver, inputs and earlier-work guard. */
function borrowedArrayDate(call: CallExpression): boolean {
  const selected = borrowedArrayText(call);
  if (selected === undefined) return false;
  const inputs = [...call.arguments, ...(selected.bound?.arguments ?? [])];
  if (
    !dateCoowned(call.expression, call) ||
    !dateCoowned(selected.receiver, call) ||
    inputs.some((input) => !dateCoowned(input, call)) ||
    !dateInputsQuiet(inputs, call, BORROWED_FIELDS) ||
    !framedQuietTextPrefix(call, BORROWED_FIELDS, (prior) => prior === selected.bound)
  )
    return false;
  const prefix = framedArgumentPrefix(call, selected.given, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return false;
  const read = selected.bound ?? call;
  return (
    (selected.name === 'join' &&
      joinedDateSeparator(call, selected.receiver, prefix.values, read)) ||
    (prefix.values.every((argument) => framedQuietPrimitive(argument)) &&
      arrayDateSource(selected.receiver, read))
  );
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
  return given === undefined
    ? undefined
    : { receiver: borrowed.receiver, given, name: borrowed.path.at(-1) ?? '', bound: undefined };
}

/** Function.apply accepts an omitted or native nullish list; Reflect.apply requires an object list. */
function nullishArrayArguments(expression: Expression): boolean {
  const value = framedQuietSource(expression);
  return (
    value !== undefined &&
    (value.kind === SyntaxKind.NullKeyword || globalPathOf(value)?.join('.') === 'undefined')
  );
}

/** Both addition operands evaluate before coercion; only a quiet primitive accompanies the array. */
function additionArrayDate(node: BinaryExpression): boolean {
  const operation = node.operatorToken.kind;
  if (operation !== SyntaxKind.PlusToken && operation !== SyntaxKind.PlusEqualsToken) return false;
  const left =
    conversionLocalSource(node.left, node) ??
    (operation === SyntaxKind.PlusToken ? node.left : undefined);
  if (left === undefined) return false;
  const right = conversionLocalSource(node.right, node) ?? node.right;
  return (
    (framedQuietPrimitive(left) && dateCoowned(right, node) && arrayDateSource(right, node)) ||
    (framedQuietPrimitive(right) && dateCoowned(left, node) && arrayDateSource(left, node))
  );
}

/** A whole local mutable operand retains its earlier possible initializer under the existing prefix proof. */
function conversionLocalSource(
  expression: Expression,
  consumer: Expression,
): Expression | undefined {
  const target = unwrapped(expression);
  if (!isIdentifier(target)) return undefined;
  const selected = frameBindingOf(target);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  if (
    !isVariableDeclaration(binding) ||
    !isIdentifier(binding.name) ||
    !isVariableDeclarationList(binding.parent) ||
    binding.initializer === undefined ||
    binding.end >= consumer.pos ||
    !framedPrefixSameOwner(binding, consumer) ||
    !/^(?:let|var)\b/u.test(binding.parent.getText(binding.getSourceFile()))
  )
    return undefined;
  return isBlockScoped(binding.parent) || singleAssignmentVar(binding, consumer)
    ? binding.initializer
    : undefined;
}

/** Only this native Date text owner opts into guarded local array initializer ownership. */
function dateCoowned(value: Expression, consumer: Expression): boolean {
  return framedOriginCoowned(value, consumer, localArrayInitializer);
}

/** The original initializer is rechecked by the existing ownership walk, including const aliases. */
function localArrayInitializer(name: Identifier, consumer: Expression): Expression | undefined {
  const read = name.pos < consumer.pos ? name : consumer;
  const source = conversionLocalSource(name, read);
  const array = source === undefined ? undefined : framedQuietSource(source);
  return array !== undefined && isArrayLiteralExpression(array) ? source : undefined;
}

/** Selected mutable array data keeps the same owner and original conversion read point. */
function dateSource(value: Expression, consumer: Expression): Expression | undefined {
  const original = framedQuietSource(value);
  if (original !== undefined) return original;
  const aliases = new Set<FrameBinding>();
  let source = unwrapped(value);
  let read = consumer;
  while (isIdentifier(source)) {
    const selected = frameBindingOf(source);
    if (selected === undefined || selected.keys.length > 0 || aliases.has(selected.binding))
      return undefined;
    const { binding } = selected;
    const local = conversionLocalSource(source, read);
    if (local !== undefined) {
      aliases.add(binding);
      return argumentArrayExposed(value, aliases) ? undefined : framedQuietSource(local);
    }
    if (
      !isVariableDeclaration(binding) ||
      !isIdentifier(binding.name) ||
      !isVariableDeclarationList(binding.parent) ||
      binding.initializer === undefined ||
      binding.end >= read.pos ||
      !framedPrefixSameOwner(binding, read) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
    )
      return undefined;
    aliases.add(binding);
    source = unwrapped(binding.initializer);
    read = source;
  }
  return undefined;
}

/** Every raw wrapper input is evaluated; only finite array entries gain the local source option. */
function dateInputsQuiet(
  inputs: readonly Expression[],
  consumer: Expression,
  natives: ReadonlySet<string>,
): boolean {
  const pending = [...inputs];
  const seen = new Set<Expression>();
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (seen.has(value)) continue;
    seen.add(value);
    if (framedQuietInputs([value], natives)) continue;
    const source = dateSource(value, consumer);
    if (source === undefined) return false;
    if (isArrayLiteralExpression(source)) pending.push(...source.elements);
    else if (isSpreadElement(source)) pending.push(source.expression);
    else return false;
  }
  return true;
}

/** Another hoisted declaration of a var may replace its value without an assignment expression. */
function singleAssignmentVar(binding: VariableDeclaration, consumer: Expression): boolean {
  if (!isIdentifier(binding.name)) return false;
  const name = binding.name.text;
  let region: Node = binding;
  while (framedPrefixSameOwner(region.parent, consumer)) region = region.parent;
  return hoistedIn([region]).every(
    (other) =>
      other === binding || bindingIdentifiers(other.name).every((bound) => bound.text !== name),
  );
}

/** Untagged substitutions become text in order; unknown earlier conversion retains opacity. */
function templateArrayDate(node: TemplateExpression): boolean {
  if (isTaggedTemplateExpression(node.parent)) return false;
  for (const span of node.templateSpans) {
    if (dateCoowned(span.expression, node) && arrayDateSource(span.expression, node)) return true;
    if (!framedQuietPrimitive(span.expression)) return false;
  }
  return false;
}

/** Every original String argument evaluates before its selected first input becomes text. */
function stringDate(node: CallExpression | NewExpression): boolean {
  if (!framedNativeConstructor(node.expression, STRINGS) || !dateCoowned(node.expression, node))
    return false;
  const given = node.arguments ?? [];
  const values = dateStringArguments(node, given);
  if (values === undefined) return false;
  if (
    given.some((value) => isSpreadElement(value)) &&
    (given.some((value) => !dateCoowned(value, node)) || !dateInputsQuiet(given, node, DATES))
  )
    return false;
  const [first, ...remaining] = values;
  return (
    first !== undefined &&
    remaining.every((argument) => framedQuietPrimitive(argument)) &&
    dateCoowned(first, node) &&
    (renderDateConversionSource(first, node) || arrayDateSource(first, node))
  );
}

/** Finite spreads reuse native argument selection; local mutable tuples use original literal entries. */
function dateStringArguments(
  node: CallExpression | NewExpression,
  given: readonly Expression[],
): readonly Expression[] | undefined {
  const values: Expression[] = [];
  for (const argument of given) {
    let selected = [argument];
    if (isSpreadElement(argument)) {
      const source = conversionLocalSource(argument.expression, node);
      const array = source === undefined ? undefined : framedQuietSource(source);
      if (array !== undefined && isArrayLiteralExpression(array)) selected = [...array.elements];
    }
    const prefix = framedArgumentPrefix(node, selected, Infinity);
    if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
    values.push(...prefix.values);
  }
  return values;
}

/** Native join and toString retain Date text only before own method, element or iterator exposure. */
function joinedDate(node: CallExpression, read: Expression = node): boolean {
  const method = node.expression;
  if (!isPropertyAccessExpression(method) && !isElementAccessExpression(method)) return false;
  const name = frameMemberName(method) ?? '';
  if (!ARRAY_TEXT.has(name) || !dateCoowned(method.expression, read)) return false;
  const given = dateStringArguments(node, node.arguments);
  if (
    given === undefined ||
    (node.arguments.some((argument) => isSpreadElement(argument)) &&
      (node.arguments.some((argument) => !dateCoowned(argument, read)) ||
        !dateInputsQuiet(node.arguments, read, DATES)))
  )
    return false;
  return (
    (name === 'join' && joinedDateSeparator(node, method.expression, given, read)) ||
    (given.every((argument) => framedQuietPrimitive(argument)) &&
      arrayDateSource(method.expression, read))
  );
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
