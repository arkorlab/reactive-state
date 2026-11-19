import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  isVoidExpression,
  type NewExpression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { literalName } from './bounded.ts';
import { COMPRESSION_FORMATS, COMPRESSION_STREAMS } from './built-ins.ts';
import { globalPathOf } from './code-globals.ts';
import { multipartMaking } from './multipart.ts';
import { constantValue } from './numbers.ts';
import { platformInitializer } from './platform-inputs.ts';
import { peelPlatform, platformPathsOf } from './platform-uses.ts';

/**
 * What of the platform's classes both sides hold a shared module's code makes otherwise on each side
 * (`settled.ts`): a `Request` of a URL the code shows no absolute one — `Response.redirect` the
 * same — which a page reads against its document's and the authority, of none, refuses; a
 * compression stream of a format an authority holds not; a `Blob` or `File` of line endings
 * that may follow the host platform.
 */

/** Special URL schemes that resolve relative strings against a same-scheme document base. */
const SPECIAL_SCHEMES: readonly string[] = ['ftp', 'http', 'https', 'ws', 'wss'];

/** Special-scheme bases covering every WHATWG same-scheme relative resolution branch. */
const SPECIAL_BASES: readonly string[] = [
  ...SPECIAL_SCHEMES.map((scheme) => `${scheme}://base.invalid/dir/page`),
  'file:///C:/base/dir/page',
];

/** Argument index of the options bag on `new File(bits, name, options)`. */
const FILE_OPTIONS_INDEX = 2;

/**
 * What of `node` the platform makes otherwise on each side: `new Request(…)` and
 * `Response.redirect(…)` of a URL the code shows no absolute one (`isAbsolute`); a compression
 * stream of a format but those every side holds (`COMPRESSION_FORMATS`) — none of another node.
 */
export function platformOtherwise(node: Node): string | undefined {
  if (!isNewExpression(node) && !isCallExpression(node)) {
    return undefined;
  }
  for (const path of platformPathsOf(node.expression)) {
    const refusal = singlePathOtherwise(node, path);
    if (refusal !== undefined) {
      return refusal;
    }
  }
  return undefined;
}

/** Checks a single resolved global callee or constructor `path` for host-dependent behavior. */
function singlePathOtherwise(
  node: CallExpression | NewExpression,
  path: string,
): string | undefined {
  const [first] = node.arguments ?? [];
  const isNew = isNewExpression(node);
  const body = isNew ? (multipartMaking(node, path) ?? bodyOtherwise(node, path)) : undefined;
  if (body !== undefined) {
    return body;
  }
  if (
    ((isNew && path === 'Request') || (!isNew && path === 'Response.redirect')) &&
    !isAbsolute(first, new Set(), node)
  ) {
    return `makes \`${path}\` of a URL the code shows no absolute one, which a page reads against its document's and the authority refuses`;
  }
  return isNew && COMPRESSION_STREAMS.has(path) && !isHeldFormat(first)
    ? `makes a \`${path}\` of a format but \`gzip\`, \`deflate\` and \`deflate-raw\`, which an authority may hold not`
    : undefined;
}

/** What a body construction reads of the host platform; none of transparent line endings. */
function bodyOtherwise(node: NewExpression, path: string): string | undefined {
  if (path !== 'Blob' && path !== 'File') {
    return undefined;
  }
  const optionIndex = path === 'File' ? FILE_OPTIONS_INDEX : 1;
  const hasSpreadBeforeOptions =
    node.arguments?.slice(0, optionIndex + 1).some((each) => isSpreadElement(each)) === true;
  const options = node.arguments?.[optionIndex];
  return !hasSpreadBeforeOptions && transparentEndings(options, new Set(), node)
    ? undefined
    : 'makes a `Blob` or `File` of line endings the code shows no `transparent` one, which may follow the host platform';
}

/** Whether options the code writes keep line endings transparent, the platform's default. */
function transparentEndings(
  node: Expression | undefined,
  seen: Set<Expression>,
  before: Node,
): boolean {
  if (node === undefined) {
    return true;
  }
  const value = optionsOf(node, seen, before);
  if (isVoidExpression(value) || value.kind === SyntaxKind.NullKeyword || isUndefined(value)) {
    return true;
  }
  if (
    !isObjectLiteralExpression(value) ||
    value.properties.some((each) => readsOptionsCode(each))
  ) {
    return false;
  }
  let transparent = true;
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      transparent &&= transparentEndings(property.expression, new Set(seen), property);
      continue;
    }
    const key = optionKey(property.name);
    if (key === undefined) {
      transparent = false;
    } else if (key === 'endings') {
      transparent = transparentProperty(property);
    }
  }
  return transparent;
}

/** Accessors or a custom prototype whose option reads may alter or inherit `endings`. */
function readsOptionsCode(property: ObjectLiteralElementLike): boolean {
  return (
    isGetAccessorDeclaration(property) ||
    isSetAccessorDeclaration(property) ||
    (isPropertyAssignment(property) && optionKey(property.name) === '__proto__')
  );
}

/** Whether an `endings` property writes transparent line endings, rather than computing them. */
function transparentProperty(property: ObjectLiteralElementLike): boolean {
  if (isPropertyAssignment(property)) {
    return transparentEnding(property.initializer);
  }
  return (
    isShorthandPropertyAssignment(property) &&
    isIdentifier(property.name) &&
    transparentEnding(property.name)
  );
}

/** What options a variable around the construction is declared of, in turn. */
function optionsOf(node: Expression, seen: Set<Expression>, before: Node): Expression {
  let value = peelPlatform(node);
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = platformInitializer(value, before, optionsWrite);
    if (declared === undefined) {
      break;
    }
    value = peelPlatform(declared);
  }
  return value;
}

/** The name an option is written by, computed from constants too. */
function optionKey(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  const key = isComputedPropertyName(name)
    ? constantValue(name.expression, (value) => platformInitializer(value, value))
    : undefined;
  return typeof key === 'string' ? key : undefined;
}

/** Whether an expression names the global `undefined`. */
function isUndefined(node: Expression): boolean {
  return globalPathOf(node)?.join('.') === 'undefined';
}

/** Whether an `endings` entry is transparent or takes the transparent default. */
function transparentEnding(node: Expression): boolean {
  const value = peelPlatform(node);
  return (
    isVoidExpression(value) ||
    isUndefined(value) ||
    constantValue(value, (name) => platformInitializer(name, name, transparentWrite)) ===
      'transparent'
  );
}

/** Whether `node` is a format of compression the code writes that every side holds (`COMPRESSION_FORMATS`). */
function isHeldFormat(node: Expression | undefined): boolean {
  const format = node === undefined || isSpreadElement(node) ? undefined : peelPlatform(node);
  return (
    format !== undefined &&
    (isStringLiteral(format) || isNoSubstitutionTemplateLiteral(format)) &&
    COMPRESSION_FORMATS.has(format.text)
  );
}

/** Whether `text` parses identically standalone and against every special-scheme base URL. */
function baseIndependentUrl(text: string): boolean {
  let standalone: string;
  try {
    standalone = new URL(text).href;
  } catch {
    return false;
  }
  return SPECIAL_BASES.every((base) => {
    try {
      return new URL(text, base).href === standalone;
    } catch {
      return false;
    }
  });
}

/** Whether `prefix` begins a URL whose scheme and authority never consult a document base URL. */
function baseIndependentPrefix(prefix: string): boolean {
  return baseIndependentUrl(prefix) || baseIndependentUrl(`${prefix}example.invalid`);
}

/**
 * Whether `node` is a URL the code shows base-independent: literal text, a template or concatenation
 * prefix whose scheme and authority never resolve against a page base, or an unchanged `URL` or
 * `Request` instance.
 */
function isAbsolute(node: Expression | undefined, seen: Set<Identifier>, before: Node): boolean {
  let value = node === undefined || isSpreadElement(node) ? undefined : peelPlatform(node);
  let hasTail = false;
  while (value !== undefined) {
    const direct = directAbsoluteValue(value, hasTail);
    if (direct !== undefined) {
      return direct;
    }
    if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.PlusToken) {
      hasTail = true;
      value = peelPlatform(value.left);
      continue;
    }
    if (!isIdentifier(value) || seen.has(value)) {
      return false;
    }
    seen.add(value);
    const preserves = hasTail ? absolutePrefixWrite : absoluteWrite;
    const declared = platformInitializer(value, before, preserves);
    value = declared === undefined ? undefined : peelPlatform(declared);
  }
  return false;
}

/** Evaluates terminal URL expressions (`string`, template, or `new URL`/`new Request`). */
function directAbsoluteValue(value: Expression, hasTail: boolean): boolean | undefined {
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
    return hasTail ? baseIndependentPrefix(value.text) : baseIndependentUrl(value.text);
  }
  if (isTemplateExpression(value)) {
    return baseIndependentPrefix(value.head.text);
  }
  if (isNewExpression(value)) {
    const paths = platformPathsOf(value.expression, true);
    return !hasTail && paths.length === 1 && (paths[0] === 'URL' || paths[0] === 'Request');
  }
  return undefined;
}

/** A base-independent literal assignment keeps an already absolute URL binding absolute. */
function absoluteWrite(write: Node, target: Node): boolean {
  const assigned = assignedValue(write);
  const value = assigned === undefined ? undefined : constantValue(assigned);
  return isIdentifier(target) && typeof value === 'string' && baseIndependentUrl(value);
}

/** A base-independent prefix assignment keeps a concatenated URL prefix base-independent. */
function absolutePrefixWrite(write: Node, target: Node): boolean {
  const assigned = assignedValue(write);
  const value = assigned === undefined ? undefined : constantValue(assigned);
  return isIdentifier(target) && typeof value === 'string' && baseIndependentPrefix(value);
}

/** A transparent literal assignment keeps an already transparent entry transparent. */
function transparentWrite(write: Node, target: Node): boolean {
  const assigned = assignedValue(write);
  return (
    isIdentifier(target) && assigned !== undefined && constantValue(assigned) === 'transparent'
  );
}

/** Writes of primitive data beside `endings`, or of `transparent` itself, retain that option. */
function optionsWrite(write: Node, target: Node, held: Expression | undefined): boolean {
  const path = writtenPath(target);
  if (held === undefined || path === undefined || path.length === 0) {
    return false;
  }
  let value = peelPlatform(held);
  for (const [index, key] of path.entries()) {
    if (!plainOptions(value)) {
      return false;
    }
    const property = value.properties.findLast((entry): entry is PropertyAssignment => {
      return (
        isPropertyAssignment(entry) &&
        !isComputedPropertyName(entry.name) &&
        entry.name.text === key
      );
    });
    if (index === path.length - 1) {
      const assigned = assignedValue(write);
      if (path[0] === 'endings') {
        return assigned !== undefined && constantValue(assigned) === 'transparent';
      }
      return primitiveWrite(write, property?.initializer);
    }
    if (property === undefined) {
      return false;
    }
    value = peelPlatform(property.initializer);
  }
  return false;
}

/** A fresh ordinary object whose fields cannot dispatch setters or redirect a member path. */
function plainOptions(value: Expression): value is ObjectLiteralExpression {
  return (
    isObjectLiteralExpression(value) &&
    value.properties.every((property) => {
      return (
        isPropertyAssignment(property) &&
        !isComputedPropertyName(property.name) &&
        property.name.text !== '__proto__'
      );
    })
  );
}

/** A write that cannot introduce an object alias or run a field's custom coercion. */
function primitiveWrite(write: Node, initial: Expression | undefined): boolean {
  const assigned = assignedValue(write);
  if (assigned !== undefined) {
    return constantValue(assigned) !== undefined;
  }
  return (
    initial !== undefined &&
    constantValue(initial) !== undefined &&
    (isPrefixUnaryExpression(write) || isPostfixUnaryExpression(write)) &&
    (write.operator === SyntaxKind.PlusPlusToken || write.operator === SyntaxKind.MinusMinusToken)
  );
}

/** The static member path written beneath a lexical binding, without following aliases. */
function writtenPath(target: Node): readonly string[] | undefined {
  let value = peelPlatform(target as Expression);
  const path: string[] = [];
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = isPropertyAccessExpression(value) ? value.name.text : literalName(value);
    if (key === undefined) {
      return undefined;
    }
    path.push(key);
    value = peelPlatform(value.expression);
  }
  return isIdentifier(value) ? path.toReversed() : undefined;
}

/** The right side of a plain assignment, without compound assignment coercions. */
function assignedValue(write: Node): Expression | undefined {
  return isBinaryExpression(write) && write.operatorToken.kind === SyntaxKind.EqualsToken
    ? write.right
    : undefined;
}
