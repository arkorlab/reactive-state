import {
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTaggedTemplateExpression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { calledMember, unwrapped } from './bounded.ts';
import { metadataParameters } from './input-bindings.ts';
import { metadataCallee, metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { conversionRunsCode } from './throw-coercions.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';
import { writtenBy } from './written.ts';

/** The final source-written own descriptor a native string pattern operation invokes. */
interface Protocol {
  readonly fn?: Node;
  readonly value?: Expression;
}
const PROTOCOLS: ReadonlyMap<string, string> = new Map([
  ['match', 'match'],
  ['matchAll', 'matchAll'],
  ['replace', 'replace'],
  ['replaceAll', 'replace'],
  ['search', 'search'],
  ['split', 'split'],
]);

/** The selected protocol getter or callable, before any source-written body is inspected. */
export function stringProtocolFunction(node: Node, resolve: Resolve | undefined): Node | undefined {
  return selectedProtocol(node, resolve)?.fn;
}

/** GetMethod throws for a shown non-nullish, noncallable own protocol value. */
export function stringProtocolThrows(node: Node, resolve: Resolve | undefined): boolean {
  const value = selectedProtocol(node, resolve)?.value;
  if (value === undefined) {
    return false;
  }
  const kind = primitiveOf(value, resolve);
  return (
    (kind !== undefined && kind !== 'nothing') ||
    isSymbolWritten(value, resolve) ||
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    isClassExpression(value)
  );
}

/** Only a native text receiver and a quiet, unmodified own literal descriptor establish a call. */
function selectedProtocol(node: Node, outer: Resolve | undefined): Protocol | undefined {
  if (
    !isCallExpression(node) ||
    node.arguments.length === 0 ||
    node.arguments.some((each) => isSpreadElement(each))
  ) {
    return undefined;
  }
  const member = calledMember(unwrapped(node.expression));
  const key = member === undefined ? undefined : PROTOCOLS.get(member.name);
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const [pattern, ...later] = node.arguments;
  if (
    member === undefined ||
    key === undefined ||
    pattern === undefined ||
    earlierEffect(node, resolve) ||
    !textLiteral(writtenOf(member.of, resolve)) ||
    later.some((each) => creationEffect(each, resolve))
  ) {
    return undefined;
  }
  const object = writtenOf(pattern, resolve);
  if (!isObjectLiteralExpression(object) || creationEffect(object, resolve)) {
    return undefined;
  }
  const before = earlierProtocol(object, member.name, resolve);
  return before === null ? (ownProtocol(object, key, resolve) ?? undefined) : before;
}

/** RegExp detection reads @@match before matchAll and replaceAll select their target hook. */
function earlierProtocol(
  object: ObjectLiteralExpression,
  method: string,
  resolve: Resolve | undefined,
): Protocol | null | undefined {
  if (method !== 'matchAll' && method !== 'replaceAll') {
    return null;
  }
  const before = ownProtocol(object, 'match', resolve);
  if (before === null || before === undefined || before.fn !== undefined) {
    return before;
  }
  return before.value === undefined || knownFalsy(before.value, resolve) ? null : undefined;
}

/** A later setter pairs with an earlier getter, but does not preserve an earlier data value. */
function ownProtocol(
  object: ObjectLiteralExpression,
  key: string,
  resolve: Resolve | undefined,
): Protocol | null | undefined {
  let setter = false;
  for (const property of object.properties.toReversed()) {
    const name = ownProtocolKey(property, resolve);
    if (name === undefined) {
      return undefined;
    }
    if (name !== key) {
      continue;
    }
    if (isSetAccessorDeclaration(property)) {
      setter = true;
      continue;
    }
    if (isGetAccessorDeclaration(property)) {
      return { fn: property };
    }
    return setter ? null : entryProtocol(property, resolve);
  }
  return null;
}

/** Unknown spreads and a literal prototype setter leave descriptor selection unproven. */
function ownProtocolKey(
  property: ObjectLiteralElementLike,
  resolve: Resolve | undefined,
): string | undefined {
  if (isSpreadAssignment(property)) {
    return undefined;
  }
  if (
    isPropertyAssignment(property) &&
    (isIdentifier(property.name) || isStringLiteral(property.name)) &&
    property.name.text === '__proto__'
  ) {
    return undefined;
  }
  return protocolKey(property.name, resolve);
}

/** A final data property or method determines the value GetMethod will test. */
function entryProtocol(property: Node, resolve: Resolve | undefined): Protocol | undefined {
  if (isMethodDeclaration(property)) {
    return callableProtocol(property);
  }
  return isPropertyAssignment(property)
    ? dataProtocol(writtenOf(property.initializer, resolve), resolve)
    : undefined;
}

/** Methods receive the original text first; later parameter defaults may run application code. */
function callableProtocol(fn: Answering): Protocol | undefined {
  return metadataParameters(fn).every(
    (parameter, index) =>
      isIdentifier(parameter.name) && (parameter.initializer === undefined || index === 0),
  )
    ? { fn }
    : undefined;
}

/** A source function in a data entry keeps its actual invocation behavior. */
function dataProtocol(value: Expression, resolve: Resolve | undefined): Protocol | undefined {
  const fn = metadataCallee(value);
  return fn !== undefined && isAnswering(fn)
    ? callableProtocol(fn)
    : { value: writtenOf(value, resolve) };
}

/** Whether a key is the selected well-known symbol, another known key, or an unknown overwrite. */
function protocolKey(name: PropertyName, resolve: Resolve | undefined): string | undefined {
  if (!isComputedPropertyName(name)) {
    return '';
  }
  const value = writtenOf(name.expression, resolve);
  const symbol = symbolProtocol(value, resolve);
  return (
    symbol ??
    (isSymbolWritten(value, resolve) || constantValue(value, resolve) !== undefined
      ? ''
      : undefined)
  );
}

/** The immutable well-known symbols used by native string pattern operations. */
function symbolProtocol(node: Expression, resolve: Resolve | undefined): string | undefined {
  const path = globalCalleePath(node, resolve);
  return path?.length === 2 && path[0] === 'Symbol' && PROTOCOLS.has(path[1] ?? '')
    ? path[1]
    : undefined;
}

/** A false or nullish own @@match skips the RegExp-specific flags validation. */
function knownFalsy(value: Expression, resolve: Resolve | undefined): boolean {
  return value.kind === SyntaxKind.FalseKeyword || primitiveOf(value, resolve) === 'nothing';
}

/** Text establishes a native string receiver without an application conversion. */
function textLiteral(node: Node): boolean {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node);
}

/** Earlier application evaluation can change both a retained pattern and the native operation. */
function earlierEffect(node: Node, resolve: Resolve | undefined): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const status = { effect: false };
    each.parent.forEachChild((part) => {
      if (part.end <= each.pos && creationEffect(part, resolve)) {
        status.effect = true;
      }
    });
    if (status.effect) {
      return true;
    }
    if (isAnswering(each.parent) || isConstructorDeclaration(each.parent)) {
      break;
    }
  }
  return false;
}

/** Deferred bodies are quiet; calls, arbitrary reads, writes and implicit conversions are not. */
function creationEffect(node: Node, resolve: Resolve | undefined): boolean {
  const pending = [node];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (isAnswering(each)) {
      const key = computedMethodName(each);
      if (key !== undefined) {
        pending.push(key);
      }
      continue;
    }
    if (
      isCallExpression(each) ||
      isNewExpression(each) ||
      isSpreadAssignment(each) ||
      isTaggedTemplateExpression(each) ||
      isClassDeclaration(each) ||
      isClassExpression(each) ||
      writtenBy(each) !== undefined ||
      conversionRunsCode(each) ||
      ((isPropertyAccessExpression(each) || isElementAccessExpression(each)) &&
        symbolProtocol(each, resolve) === undefined) ||
      (isComputedPropertyName(each) && protocolKey(each, resolve) === undefined)
    ) {
      return true;
    }
    if (isPropertyAccessExpression(each) || isElementAccessExpression(each)) {
      continue;
    }
    each.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Only methods and accessors have computed names whose evaluation is not deferred. */
function computedMethodName(fn: Answering): PropertyName | undefined {
  if (!isMethodDeclaration(fn) && !isGetAccessorDeclaration(fn)) {
    return undefined;
  }
  return isComputedPropertyName(fn.name) ? fn.name : undefined;
}
