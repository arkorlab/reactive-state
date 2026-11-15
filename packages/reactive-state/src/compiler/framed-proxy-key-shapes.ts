import {
  type Expression,
  type Node,
  type PropertyName,
  type VariableDeclaration,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isComputedPropertyName,
  isConditionalExpression,
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isIfStatement,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isStringLiteral,
  isSwitchStatement,
  isTryStatement,
  isVariableDeclaration,
  isVariableStatement,
  isWhileStatement,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** A fresh native Proxy's closed ownKeys result replaces target-key enumeration alone. */

const PROXIES = new Set(['Proxy']);
interface ProxySource {
  readonly value: Expression;
  readonly allowed: ReadonlySet<Node>;
  readonly bindings: ReadonlySet<Node>;
}

/** Only a direct fixed string-list trap suppresses an underlying Error shape observation. */
export function framedProxyFixedKeys(node: Expression, consumer: Node): boolean {
  const source = framedProxySource(node, consumer);
  const value = source?.value;
  if (
    source === undefined ||
    value === undefined ||
    !isNewExpression(value) ||
    !framedNativeConstructor(value.expression, PROXIES) ||
    value.arguments?.length !== 2
  )
    return false;
  const handler = value.arguments[1];
  if (handler === undefined || !fixedHandlerKeys(handler)) return false;
  return framedProxyUnexposed(consumer, source);
}

/** The final literal ownKeys definition wins; uncertain names and application evaluation stay opaque. */
function fixedHandlerKeys(node: Expression): boolean {
  const value = unwrapped(node);
  if (!isObjectLiteralExpression(value)) return false;
  let trap: Node | undefined;
  for (const property of value.properties) {
    const name = 'name' in property ? property.name : undefined;
    const key = name === undefined ? undefined : framedProxyHandlerKey(name);
    if (key === undefined || key === '__proto__' || !framedProxyHandlerEntryQuiet(property))
      return false;
    if (key === 'ownKeys') trap = property;
  }
  return trap !== undefined && fixedTrapKeys(trap);
}

/** A handler's unrelated fields evaluate no application getter, call or computed-key conversion. */
export function framedProxyHandlerEntryQuiet(node: Node): boolean {
  if (
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isShorthandPropertyAssignment(node)
  )
    return true;
  if (!isPropertyAssignment(node)) return false;
  const value = unwrapped(node.initializer);
  return (
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isIdentifier(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isNumericLiteral(value) ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword
  );
}

/** Only literal handler names retain an unambiguous final trap. */
export function framedProxyHandlerKey(node: PropertyName): string | undefined {
  if (isIdentifier(node) || isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (isNumericLiteral(node)) return node.text;
  if (!isComputedPropertyName(node)) return undefined;
  const key = unwrapped(node.expression);
  return isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key) ? key.text : undefined;
}

/** A synchronous closed trap returns its literal string list without a parameter initializer. */
function fixedTrapKeys(node: Node): boolean {
  const value = isPropertyAssignment(node) ? unwrapped(node.initializer) : node;
  if (!isMethodDeclaration(value) && !isArrowFunction(value) && !isFunctionExpression(value))
    return false;
  if (answersLater(value) || value.body === undefined) return false;
  if (
    value.parameters.some((parameter) => {
      return (
        !isIdentifier(parameter.name) ||
        parameter.initializer !== undefined ||
        parameter.dotDotDotToken !== undefined
      );
    })
  )
    return false;
  const body = value.body;
  if (!isBlock(body)) return fixedList(body);
  const [statement] = body.statements;
  return (
    body.statements.length === 1 &&
    statement !== undefined &&
    isReturnStatement(statement) &&
    statement.expression !== undefined &&
    fixedList(statement.expression)
  );
}

/** Written string elements cannot acquire keys from the target or application callbacks. */
function fixedList(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isArrayLiteralExpression(value) &&
    value.elements.every((element) => {
      const key = unwrapped(element);
      return isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key);
    })
  );
}

/** Whole constant Proxy aliases keep their original construction in the consumer's owner and block. */
export function framedProxySource(node: Expression, consumer: Node): ProxySource | undefined {
  const allowed = new Set<Node>();
  const bindings = new Set<Node>();
  const block = nearestBlock(consumer);
  let value = unwrapped(node);
  while (isIdentifier(value)) {
    if (allowed.has(value)) return undefined;
    allowed.add(value);
    const binding = wholeConstant(value);
    if (
      binding?.initializer === undefined ||
      bindings.has(binding) ||
      binding.parent.parent.parent !== block ||
      executionOwner(binding) !== executionOwner(consumer)
    )
      return undefined;
    bindings.add(binding);
    allowed.add(binding.name);
    value = unwrapped(binding.initializer);
  }
  return bindings.size > 0 && !ordinaryConsumer(consumer, block)
    ? undefined
    : { value, allowed, bindings };
}

/** Every other prior, same-call or captured Proxy use can change a handler through another trap. */
export function framedProxyUnexposed(consumer: Node, source: ProxySource): boolean {
  if (source.bindings.size === 0) return true;
  const owner = executionOwner(consumer);
  const pending: Node[] = [consumer.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && !source.allowed.has(node) && readsBinding(node)) {
      const binding = frameDeclarationOf(node);
      if (
        binding !== undefined &&
        source.bindings.has(binding) &&
        (node.end <= consumer.end || executionOwner(node) !== owner)
      )
        return false;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Repeated or branching statement owners do not establish a first unchanged alias observation. */
function ordinaryConsumer(node: Node, block: Node): boolean {
  for (let at = node; at !== block; at = at.parent) {
    if (
      isForStatement(at) ||
      isForInStatement(at) ||
      isForOfStatement(at) ||
      isWhileStatement(at) ||
      isDoStatement(at) ||
      isIfStatement(at) ||
      isConditionalExpression(at) ||
      isSwitchStatement(at) ||
      isTryStatement(at)
    )
      return false;
  }
  return true;
}

/** The original nearest block retains the selected receiver's statement position. */
function nearestBlock(node: Node): Node {
  let at = node;
  while (!isBlock(at) && !isSourceFile(at)) at = at.parent;
  return at;
}

/** Only whole const bindings retain a Proxy source; projections and mutable aliases stay opaque. */
function wholeConstant(node: Expression): VariableDeclaration | undefined {
  if (!isIdentifier(node)) return undefined;
  const selected = frameBindingOf(node);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  if (!isVariableDeclaration(binding) || !isIdentifier(binding.name)) return undefined;
  const statement = binding.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    ? binding
    : undefined;
}
