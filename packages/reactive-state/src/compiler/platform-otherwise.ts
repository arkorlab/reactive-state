import {
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isPropertyAccessExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  isVoidExpression,
  type Node,
  type NewExpression,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { COMPRESSION_FORMATS, COMPRESSION_STREAMS } from './built-ins.ts';
import { globalPathOf } from './code-globals.ts';
import { multipartMaking } from './multipart.ts';
import { constantValue } from './numbers.ts';
import { platformInitializer } from './platform-inputs.ts';

/**
 * What of the platform's classes both sides hold a shared module's code makes otherwise on each side
 * (`settled.ts`): a `Request` of a URL the code shows no absolute one — `Response.redirect` the
 * same — which a page reads against its document's and the authority, of none, refuses; a
 * compression stream of a format an authority holds not; a `Blob` or `File` of line endings
 * that may follow the host platform.
 */

/** The scheme an absolute URL starts with: `https:`. */
const SCHEME = /^[a-z][\d+.a-z-]*:/iu;

/**
 * What of `node` the platform makes otherwise on each side: `new Request(…)` and
 * `Response.redirect(…)` of a URL the code shows no absolute one (`isAbsolute`); a compression
 * stream of a format but those every side holds (`COMPRESSION_FORMATS`) — none of another node.
 */
export function platformOtherwise(node: Node): string | undefined {
  if (!isNewExpression(node) && !isCallExpression(node)) {
    return undefined;
  }
  const path = globalPathOf(unwrapped(node.expression))?.join('.');
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
  return isNew && path !== undefined && COMPRESSION_STREAMS.has(path) && !isHeldFormat(first)
    ? `makes a \`${path}\` of a format but \`gzip\`, \`deflate\` and \`deflate-raw\`, which an authority may hold not`
    : undefined;
}

/** What a body construction reads of the host platform; none of transparent line endings. */
function bodyOtherwise(node: NewExpression, path: string | undefined): string | undefined {
  if (path !== 'Blob' && path !== 'File') {
    return undefined;
  }
  const options = path === 'File' ? node.arguments?.[2] : node.arguments?.[1];
  return transparentEndings(options, new Set(), node)
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
  if (!isObjectLiteralExpression(value)) {
    return false;
  }
  let transparent = true;
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      transparent &&= transparentEndings(property.expression, new Set(seen), before);
      continue;
    }
    const key = optionKey(property.name, before);
    if (key === undefined) {
      transparent = false;
    } else if (key === 'endings') {
      transparent = transparentProperty(property, before);
    }
  }
  return transparent;
}

/** Whether an `endings` property writes transparent line endings, rather than computing them. */
function transparentProperty(property: ObjectLiteralElementLike, before: Node): boolean {
  if (isPropertyAssignment(property)) {
    return transparentEnding(property.initializer, before);
  }
  return (
    isShorthandPropertyAssignment(property) &&
    isIdentifier(property.name) &&
    transparentEnding(property.name, before)
  );
}

/** What options a variable around the construction is declared of, in turn. */
function optionsOf(node: Expression, seen: Set<Expression>, before: Node): Expression {
  let value = unwrapped(node);
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = platformInitializer(value, before, optionsWrite);
    if (declared === undefined) {
      break;
    }
    value = unwrapped(declared);
  }
  return value;
}

/** The name an option is written by, computed from constants too. */
function optionKey(name: PropertyName, before: Node): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  const key = isComputedPropertyName(name)
    ? constantValue(name.expression, (value) => platformInitializer(value, before))
    : undefined;
  return typeof key === 'string' ? key : undefined;
}

/** Whether an expression names the global `undefined`. */
function isUndefined(node: Expression): boolean {
  return globalPathOf(node)?.join('.') === 'undefined';
}

/** Whether an `endings` entry is transparent or takes the transparent default. */
function transparentEnding(node: Expression, before: Node): boolean {
  const value = unwrapped(node);
  return (
    isVoidExpression(value) ||
    isUndefined(value) ||
    constantValue(value, (name) => platformInitializer(name, before, transparentWrite)) ===
      'transparent'
  );
}

/** Whether `node` is a format of compression the code writes that every side holds (`COMPRESSION_FORMATS`). */
function isHeldFormat(node: Expression | undefined): boolean {
  const format = node === undefined || isSpreadElement(node) ? undefined : unwrapped(node);
  return (
    format !== undefined &&
    (isStringLiteral(format) || isNoSubstitutionTemplateLiteral(format)) &&
    COMPRESSION_FORMATS.has(format.text)
  );
}

/**
 * Whether `node` is a URL the code shows absolute: text it writes that starts of a scheme, `https:`,
 * or of a template whose text before what it computes does, or text added to such text; a `URL` or
 * a `Request` it makes, whose own is absolute; what a variable around it is declared of, in turn.
 */
function isAbsolute(node: Expression | undefined, seen: Set<Identifier>, before: Node): boolean {
  let value = node === undefined || isSpreadElement(node) ? undefined : unwrapped(node);
  while (value !== undefined) {
    if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
      return SCHEME.test(value.text);
    }
    if (isTemplateExpression(value)) {
      return SCHEME.test(value.head.text);
    }
    if (isNewExpression(value)) {
      const made = globalPathOf(unwrapped(value.expression))?.join('.');
      return made === 'URL' || made === 'Request';
    }
    // `'https://example.com/' + path`: of text that starts of a scheme.
    if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.PlusToken) {
      value = unwrapped(value.left);
      continue;
    }
    if (!isIdentifier(value) || seen.has(value)) {
      return false;
    }
    seen.add(value);
    const declared = platformInitializer(value, before, absoluteWrite);
    value = declared === undefined ? undefined : unwrapped(declared);
  }
  return false;
}

/** An absolute literal assignment keeps an already absolute input absolute. */
function absoluteWrite(write: Node, target: Node): boolean {
  const assigned = assignedValue(write);
  const value = assigned === undefined ? undefined : constantValue(assigned);
  return isIdentifier(target) && typeof value === 'string' && SCHEME.test(value);
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
  let value = unwrapped(held);
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
    value = unwrapped(property.initializer);
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
  let value = unwrapped(target as Expression);
  const path: string[] = [];
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = isPropertyAccessExpression(value) ? value.name.text : literalName(value);
    if (key === undefined) {
      return undefined;
    }
    path.push(key);
    value = unwrapped(value.expression);
  }
  return isIdentifier(value) ? path.toReversed() : undefined;
}

/** The right side of a plain assignment, without compound assignment coercions. */
function assignedValue(write: Node): Expression | undefined {
  return isBinaryExpression(write) && write.operatorToken.kind === SyntaxKind.EqualsToken
    ? write.right
    : undefined;
}
