import {
  type ConditionalExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isConditionalExpression,
  isFunctionDeclaration,
  isIdentifier,
  isPrefixUnaryExpression,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTypeOfExpression,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { constantDeclaration, mentionsAccessibleArguments } from './framed-template-arguments.ts';
import { singleUnchangedFunctionBody } from './framed-written-error-parameters.ts';
import { isTypeOnly, readsBinding } from './scope.ts';
import { useOf } from './uses.ts';

/**
 * Untagged template literals coerce every substitution to text, whereas tagged templates hand
 * substitutions unchanged to the tag: only proven source-written tags that neither coerce nor
 * expose an error-carrying substitution avoid framed error words.
 */

const STRICT_EQUALITY: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
]);

/** Whether a template or tagged-template expression can convert or forward framed error words. */
export function framedTemplateText(
  node: Node,
  converts: (value: Expression | undefined) => boolean,
): boolean {
  if (isTemplateExpression(node)) {
    return (
      !isTaggedTemplateExpression(node.parent) &&
      node.templateSpans.some((span) => converts(span.expression))
    );
  }
  if (!isTaggedTemplateExpression(node) || !isTemplateExpression(node.template)) {
    return false;
  }
  const slots: number[] = [];
  for (const [index, span] of node.template.templateSpans.entries()) {
    if (converts(span.expression)) slots.push(index);
  }
  if (slots.length === 0) return false;
  const functions = resolvedTagFunctions(node.tag, new Set());
  return (
    functions === undefined ||
    functions.length === 0 ||
    functions.some((fn) => !ignoresErrorSlots(fn, slots))
  );
}

/** Follows inline functions, unchanged function declarations, const aliases and conditionals. */
function resolvedTagFunctions(tag: Expression, seen: Set<Node>): readonly Answering[] | undefined {
  const value = unwrapped(tag);
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (isConditionalExpression(value)) return conditionalTagFunctions(value, seen);
  if (isAnswering(value)) return [value];
  return isIdentifier(value) ? namedTagFunctions(value, seen) : undefined;
}

/** Both branches of a conditional tag must resolve to proven source-written functions. */
function conditionalTagFunctions(
  node: ConditionalExpression,
  seen: Set<Node>,
): readonly Answering[] | undefined {
  const left = resolvedTagFunctions(node.whenTrue, new Set(seen));
  if (left === undefined) return undefined;
  const right = resolvedTagFunctions(node.whenFalse, new Set(seen));
  return right === undefined ? undefined : [...left, ...right];
}

/** Resolves an identifier tag to an unmutated function declaration or constant initializer. */
function namedTagFunctions(name: Identifier, seen: Set<Node>): readonly Answering[] | undefined {
  const declared = frameDeclarationOf(name);
  if (declared === undefined) return undefined;
  if (isFunctionDeclaration(declared)) {
    const body = singleUnchangedFunctionBody(declared);
    return body === undefined ? undefined : [body];
  }
  if (
    !isVariableDeclaration(declared) ||
    declared.initializer === undefined ||
    !constantDeclaration(declared)
  ) {
    return undefined;
  }
  return resolvedTagFunctions(declared.initializer, seen);
}

/** Every error-carrying substitution slot must remain unread or strictly tested without escaping. */
function ignoresErrorSlots(fn: Answering, slots: readonly number[]): boolean {
  if (fn.body === undefined || mentionsAccessibleArguments(fn)) return false;
  return slots.every((slot) => ignoresSlot(fn, slot));
}

/** Checks one substitution index against preceding rest parameters and its positional parameter. */
function ignoresSlot(fn: Answering, slot: number): boolean {
  const parameters = parametersOf(fn);
  const targetIndex = slot + 1;
  for (const [index, parameter] of parameters.entries()) {
    if (parameter.dotDotDotToken !== undefined && index <= targetIndex) {
      return safeParameterReads(fn, parameter, false);
    }
  }
  const parameter = parameters[targetIndex];
  return parameter === undefined || safeParameterReads(fn, parameter, true);
}

/** Parameter reads are safe only when absent or confined to non-coercing boolean/void/typeof checks. */
function safeParameterReads(
  fn: Answering,
  parameter: ParameterDeclaration,
  allowTests: boolean,
): boolean {
  if (!isIdentifier(parameter.name) || fn.body === undefined) return false;
  const name = parameter.name.text;
  const pending: Node[] = [...parametersOf(fn), fn.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isIdentifier(node) &&
      node !== parameter.name &&
      node.text === name &&
      readsBinding(node) &&
      frameDeclarationOf(node) === parameter &&
      (!allowTests || !nonCoercingTestUse(node))
    ) {
      return false;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** `typeof`, `void`, `!`, `===` and `!==` neither coerce objects nor forward their operand. */
function nonCoercingTestUse(node: Identifier): boolean {
  const { parent } = useOf(node);
  return (
    isTypeOfExpression(parent) ||
    isVoidExpression(parent) ||
    (isPrefixUnaryExpression(parent) && parent.operator === SyntaxKind.ExclamationToken) ||
    (isBinaryExpression(parent) && STRICT_EQUALITY.has(parent.operatorToken.kind))
  );
}
