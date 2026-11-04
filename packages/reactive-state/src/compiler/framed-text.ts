import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isLiteralTypeNode,
  isIdentifier,
  isVoidExpression,
  isNoSubstitutionTemplateLiteral,
  isParenthesizedTypeNode,
  isPropertyAccessExpression,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { framedArrayTextArguments } from './framed-array-text-inputs.ts';
import { arrayError } from './framed-arrays.ts';
import { frameBindingOf, frameMemberName, frameTypeOf } from './framed-bindings.ts';
import { framedGenericErrorText } from './framed-generic-error-text.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietArrayWords,
  framedQuietInputs,
  framedQuietPrimitive,
} from './framed-native-evaluation.ts';
import { framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedNativeRaw, framedNativeRawApply } from './framed-native-raw.ts';
import { framedReplacementCallback } from './framed-replacement-callbacks.ts';
import { framedCondition, framedNativeConstructor } from './framed-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { constantValue } from './numbers.ts';

/** Native text operations whose arguments are converted rather than retained as values. */

const NATIVE_REPLACEMENTS: ReadonlySet<string> = new Set([
  'String.prototype.replace',
  'String.prototype.replaceAll',
]);

const NATIVE_PADDING: ReadonlySet<string> = new Set([
  'String.prototype.padEnd',
  'String.prototype.padStart',
]);

const SEARCH_METHODS: ReadonlySet<string> = new Set([
  'endsWith',
  'includes',
  'indexOf',
  'lastIndexOf',
  'localeCompare',
  'match',
  'matchAll',
  'search',
  'split',
  'startsWith',
]);

const RECEIVER_TEXT_METHODS: ReadonlySet<string> = new Set([
  'anchor',
  'at',
  'big',
  'blink',
  'bold',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'fixed',
  'fontcolor',
  'fontsize',
  'isWellFormed',
  'italics',
  'link',
  'normalize',
  'repeat',
  'slice',
  'small',
  'strike',
  'sub',
  'substr',
  'substring',
  'sup',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLowerCase',
  'toUpperCase',
  'toWellFormed',
  'trim',
  'trimEnd',
  'trimLeft',
  'trimRight',
  'trimStart',
]);

const STRING_PROTOTYPE = 'String.prototype';

const HTML_ATTRIBUTES: ReadonlySet<string> = new Set(['anchor', 'fontcolor', 'fontsize', 'link']);

const HTML_NATIVES: ReadonlySet<string> = new Set([
  'Reflect.apply',
  'String',
  'String.prototype.anchor',
  'String.prototype.fontcolor',
  'String.prototype.fontsize',
  'String.prototype.link',
  STRING_PROTOTYPE,
]);

const URI_CONVERSIONS: ReadonlySet<string> = new Set([
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'unescape',
]);

type BorrowedText = NonNullable<ReturnType<typeof borrowedTextCall>>;

interface TextWords {
  readonly error: (value: Expression) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** A written native text operation that converts at least one engine error's words. */
export function framedStringText(
  node: Node,
  error: (value: Expression) => boolean,
  typed: (value: Expression) => boolean = () => false,
): boolean {
  if (!isCallExpression(node)) return false;
  const words = { error, typed };
  const native = nativeGlobalStringText(node, words);
  if (native !== undefined) return native;
  if (borrowedStringText(node, words)) return true;
  const member = unwrapped(node.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return false;
  const method = frameMemberName(member);
  const replacement = method === 'replace' || method === 'replaceAll';
  const padding = method === 'padEnd' || method === 'padStart';
  const search = SEARCH_METHODS.has(method ?? '');
  const html = HTML_ATTRIBUTES.has(method ?? '');
  if (!argumentTextMethod(method) || !stringReceiver(member.expression)) return false;
  if (html) return htmlArguments(node.arguments, words, node, member.expression);
  if (padding) return paddingArguments(node.arguments, words, node, member.expression);
  if (search) return searchArguments(node.arguments, words, node);
  return replacement
    ? replacementArguments(node.arguments, words, node, member.expression)
    : concatArguments(node.arguments, words, node);
}

/** The existing argument-converting families and HTML attributes share the direct dispatch. */
function argumentTextMethod(method = ''): boolean {
  const native = `String.prototype.${method}`;
  return (
    method === 'concat' ||
    NATIVE_REPLACEMENTS.has(native) ||
    NATIVE_PADDING.has(native) ||
    SEARCH_METHODS.has(method) ||
    HTML_ATTRIBUTES.has(method)
  );
}

/** Native global conversions retain their individual consumed-argument rules. */
function nativeGlobalStringText(node: CallExpression, words: TextWords): boolean | undefined {
  const path = globalPathOf(sourceTextValue(node.expression))?.join('.');
  if (path === 'String.raw') return framedNativeRaw(node, node.arguments, words);
  return URI_CONVERSIONS.has(path ?? '') ? searchArguments(node.arguments, words, node) : undefined;
}

/** Borrowed native text methods retain their receiver and only the arguments they consume. */
function borrowedStringText(node: CallExpression, words: TextWords): boolean {
  const borrowed = borrowedTextCall(node);
  if (borrowed?.path.join('.') === 'Error.prototype.toString')
    return (
      words.error(borrowed.receiver) || framedGenericErrorText(borrowed.receiver, node, words.error)
    );
  if (borrowed === undefined) return false;
  if (borrowed.path.join('.') === 'String.raw')
    return borrowed.applied === undefined
      ? framedNativeRaw(node, borrowed.given, words)
      : framedNativeRawApply(node, borrowed.applied, words);
  if (URI_CONVERSIONS.has(borrowed.path.join('.'))) {
    return (
      searchArguments(borrowed.given, words, node) ||
      (borrowed.applied !== undefined && searchApply(borrowed.applied, words, node))
    );
  }
  if (
    borrowed.path.slice(0, -1).join('.') === STRING_PROTOTYPE &&
    SEARCH_METHODS.has(borrowed.path.at(-1) ?? '')
  ) {
    return (
      words.error(borrowed.receiver) ||
      searchArguments(borrowed.given, words, node) ||
      (borrowed.applied !== undefined && searchApply(borrowed.applied, words, node))
    );
  }
  if (
    borrowed.path.slice(0, -1).join('.') === STRING_PROTOTYPE &&
    RECEIVER_TEXT_METHODS.has(borrowed.path.at(-1) ?? '')
  )
    return borrowedReceiverText(borrowed, words, node);
  return borrowedStringOperation(borrowed, words, node);
}

/** Existing receiver conversions remain independent of the additional HTML attribute proof. */
function borrowedReceiverText(
  borrowed: BorrowedText,
  words: TextWords,
  call: CallExpression,
): boolean {
  return (
    words.error(borrowed.receiver) ||
    (HTML_ATTRIBUTES.has(borrowed.path.at(-1) ?? '') &&
      borrowedHtmlArguments(borrowed, words, call))
  );
}

/** A resolved native apply list retains its consumed attribute without assuming unknown getters. */
function borrowedHtmlArguments(
  borrowed: BorrowedText,
  words: TextWords,
  call: CallExpression,
): boolean {
  const args =
    borrowed.applied === undefined
      ? borrowed.given
      : framedAppliedArguments(call, borrowed.applied);
  return args !== undefined && htmlArguments(args, words, call, borrowed.receiver);
}

/** Only the first HTML attribute converts after quiet receiver and complete operand evaluation. */
function htmlArguments(
  args: readonly Expression[],
  words: TextWords,
  call: CallExpression,
  receiver: Expression,
): boolean {
  if (
    !framedQuietPrimitive(receiver) ||
    sourceTextValue(receiver).kind === SyntaxKind.NullKeyword ||
    globalPathOf(sourceTextValue(receiver))?.join('.') === 'undefined' ||
    !quietHtmlCallee(call) ||
    !framedQuietInputs(call.arguments, HTML_NATIVES) ||
    !framedQuietOwnerPrefix(call, {
      primitive: framedQuietPrimitive,
      value: (value) => framedNativeConstructor(value, HTML_NATIVES),
    })
  )
    return false;
  const prefix = framedArgumentPrefix(call, args, 1);
  const value = prefix.values[0];
  return (
    !prefix.unknown &&
    prefix.alternatives === undefined &&
    value !== undefined &&
    ((framedNativeErrorInput(value, call) && words.error(value)) ||
      (framedQuietArrayWords(value, words.error, call) && arrayError(value, words, call)))
  );
}

/** Computed callee names are evaluated before any attribute and need their own quiet proof. */
function quietHtmlCallee(call: CallExpression): boolean {
  let value = unwrapped(call.expression);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
      return false;
    value = unwrapped(value.expression);
  }
  return true;
}

/** Native concatenation, replacement and padding use their respective consumed positions. */
function borrowedStringOperation(
  borrowed: BorrowedText,
  words: TextWords,
  node: CallExpression,
): boolean {
  if (borrowed.path.join('.') === 'String.prototype.concat') {
    return (
      words.error(borrowed.receiver) ||
      concatArguments(borrowed.given, words, node) ||
      (borrowed.applied !== undefined && arrayError(borrowed.applied, words, node))
    );
  }
  if (NATIVE_REPLACEMENTS.has(borrowed.path.join('.'))) {
    return (
      words.error(borrowed.receiver) ||
      replacementArguments(borrowed.given, words, node, borrowed.receiver) ||
      (borrowed.applied !== undefined &&
        replacementApply(borrowed.applied, words, node, borrowed.receiver))
    );
  }
  if (NATIVE_PADDING.has(borrowed.path.join('.'))) {
    return (
      words.error(borrowed.receiver) ||
      paddingArguments(borrowed.given, words, node, borrowed.receiver) ||
      (borrowed.applied !== undefined &&
        paddingApply(borrowed.applied, words, node, borrowed.receiver))
    );
  }
  return false;
}

/** Call arguments and written spread elements are converted in their supplied positions. */
function concatArguments(args: readonly Expression[], words: TextWords, call: Node): boolean {
  return (
    args.some((argument) => {
      return isSpreadElement(argument)
        ? arrayError(argument.expression, words, call)
        : words.error(argument);
    }) || framedArrayTextArguments(args, words, call)
  );
}

/** The consumed search argument, without converting numeric positions or ignored trailing values. */
function searchArguments(
  args: readonly Expression[],
  words: TextWords,
  call: CallExpression,
): boolean {
  return concatArguments(framedConsumedArguments(call, args, 1), words, call);
}

/** A literal search apply list retains its first position; opaque lists keep a possible first value. */
function searchApply(expression: Expression, words: TextWords, call: CallExpression): boolean {
  const value = unwrapped(expression);
  return isArrayLiteralExpression(value)
    ? searchArguments(value.elements, words, call)
    : arrayError(value, words, call);
}

/** Search/replacement values convert directly; a known callback's synchronous result converts on a match. */
function replacementArguments(
  args: readonly Expression[],
  words: TextWords,
  call: CallExpression,
  receiver: Expression,
): boolean {
  if (concatArguments(framedConsumedArguments(call, args, 2), words, call)) return true;
  const prefix = framedArgumentPrefix(call, args);
  const callback = prefix.values[1];
  if (callback === undefined || prefix.unknown || !replacementMayMatch(receiver, prefix.values[0]))
    return false;
  return framedReplacementCallback(callback, words.error);
}

/** A source-proven missing literal search cannot invoke a replacement callback. */
function replacementMayMatch(receiver: Expression, search: Expression | undefined): boolean {
  const text = constantValue(receiver, constantInitializer);
  const selected = search === undefined ? undefined : constantValue(search, constantInitializer);
  return typeof text !== 'string' || typeof selected !== 'string' || text.includes(selected);
}

/** A literal apply list retains its two positions; opaque lists keep every entry possible. */
function replacementApply(
  expression: Expression,
  words: TextWords,
  call: CallExpression,
  receiver: Expression,
): boolean {
  const value = unwrapped(expression);
  return isArrayLiteralExpression(value)
    ? replacementArguments(value.elements, words, call, receiver)
    : arrayError(value, words, call);
}

/** Native padding converts only its fill value, after a length that still requires padding. */
function paddingArguments(
  args: readonly Expression[],
  words: TextWords,
  call: CallExpression,
  receiver: Expression,
): boolean {
  const prefix = framedArgumentPrefix(call, args);
  const first = args[0];
  const hasSize = first !== undefined && !isSpreadElement(first);
  let size = prefix.values[0];
  if (hasSize) size = first;
  if ((hasSize || !prefix.unknown) && !paddingRequired(receiver, size)) return false;
  if (!prefix.unknown) {
    const fill = prefix.values[1];
    return fill !== undefined && words.error(fill);
  }
  const values = framedConsumedArguments(call, args, 2);
  return concatArguments(hasSize ? values.filter((each) => each !== first) : values, words, call);
}

/** A literal padding apply list retains positions; opaque lists keep a possible error fill. */
function paddingApply(
  expression: Expression,
  words: TextWords,
  call: CallExpression,
  receiver: Expression,
): boolean {
  const value = unwrapped(expression);
  return isArrayLiteralExpression(value)
    ? paddingArguments(value.elements, words, call, receiver)
    : arrayError(value, words, call);
}

/** A known nonpositive length or a source-proven sufficiently long receiver avoids fill conversion. */
function paddingRequired(receiver: Expression, size: Expression | undefined): boolean {
  if (size === undefined || zeroPaddingSize(size)) return false;
  const width = constantValue(size, constantInitializer);
  if (width === undefined) return true;
  const length = Math.trunc(Number(width)) || 0;
  if (length <= 0) return false;
  const text = constantValue(receiver, constantInitializer);
  return typeof text !== 'string' || length > text.length;
}

/** Falsy primitives and the native undefined value have a zero ToLength, through whole const aliases. */
function zeroPaddingSize(size: Expression): boolean {
  if (framedCondition(size) === false) return true;
  const value = sourceTextValue(size);
  return isVoidExpression(value) || globalPathOf(value)?.join('.') === 'undefined';
}

/** Whole const aliases preserve the written primitive or native callable without following mutable holders. */
function sourceTextValue(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const next = constantInitializer(value);
    if (next === undefined) break;
    value = unwrapped(next);
  }
  return value;
}

/** Primitive text syntax, constant aliases, native conversion results or an explicit string type. */
function stringReceiver(node: Expression): boolean {
  const value = unwrapped(node);
  if (typeof constantValue(value, constantInitializer) === 'string') return true;
  if (isTemplateExpression(value)) return true;
  if (isCallExpression(value) && globalPathOf(unwrapped(value.expression))?.join('.') === 'String')
    return true;
  const selected = frameTypeOf(value);
  return selected?.keys.length === 0 && writtenString(selected.type);
}

/** Only a whole const binding can retain its primitive initializer as the receiver. */
function constantInitializer(name: Identifier): Expression | undefined {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  if (!isVariableDeclaration(binding)) return undefined;
  const statement = binding.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    ? binding.initializer
    : undefined;
}

/** An explicit primitive string type, with literal and parenthesized spellings preserved. */
function writtenString(type: TypeNode): boolean {
  let value = type;
  while (isParenthesizedTypeNode(value)) value = value.type;
  return (
    value.kind === SyntaxKind.StringKeyword ||
    (isLiteralTypeNode(value) &&
      (isStringLiteral(value.literal) || isNoSubstitutionTemplateLiteral(value.literal)))
  );
}
