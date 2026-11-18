import {
  type ConditionalExpression,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConditionalExpression,
  isConstructorDeclaration,
  isDecorator,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTypeAssertion,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { type Answering, isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
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
    !functions.every((fn) => ignoresErrorSlots(fn, slots))
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
    return unchangedFunction(declared) ? [declared] : undefined;
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

/** Whole `const` bindings keep their initializer value throughout their scope. */
function constantDeclaration(declared: VariableDeclaration): boolean {
  return (
    isIdentifier(declared.name) &&
    isVariableDeclarationList(declared.parent) &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
  );
}

/** Named function declarations keep their body when neither redeclared nor reassigned. */
function unchangedFunction(declared: FunctionDeclaration): boolean {
  if (declared.body === undefined || declared.name === undefined) return false;
  const name = declared.name.text;
  const siblings = 'statements' in declared.parent ? declared.parent.statements : undefined;
  if (
    siblings?.some(
      (each) =>
        each !== declared &&
        isFunctionDeclaration(each) &&
        each.body !== undefined &&
        each.name?.text === name,
    ) === true
  ) {
    return false;
  }
  const pending: Node[] = [declared.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isIdentifier(node) &&
      node.text === name &&
      reassignedIdentifier(node) &&
      frameDeclarationOf(node) === declared
    ) {
      return false;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Every error-carrying substitution slot must remain unread or strictly tested without escaping. */
function ignoresErrorSlots(fn: Answering, slots: readonly number[]): boolean {
  if (fn.body === undefined) return false;
  if (!isArrowFunction(fn) && mentionsOwnArguments(fn)) return false;
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

/** Non-arrow functions expose unnamed arguments when `arguments` is read in the same binding scope. */
function mentionsOwnArguments(fn: Answering): boolean {
  if (fn.body === undefined) return false;
  const pending: Node[] = [...parametersOf(fn), fn.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (node !== fn && bindsOwnArguments(node)) {
      pushOuterScopeHeader(node, pending);
      continue;
    }
    if (readsOwnArgumentsIdentifier(node)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Matches an unshadowed `arguments` value read within the current callable scope. */
function readsOwnArgumentsIdentifier(node: Node): boolean {
  return (
    isIdentifier(node) &&
    node.text === 'arguments' &&
    readsBinding(node) &&
    frameDeclarationOf(node) === undefined
  );
}

/** Computed member names and decorators evaluate in the enclosing callable's `arguments` scope. */
function pushOuterScopeHeader(node: Node, pending: Node[]): void {
  if (
    (isMethodDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)) &&
    isComputedPropertyName(node.name)
  ) {
    pending.push(node.name.expression);
  }
  if (
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node)
  ) {
    pushDecorators(node.modifiers, pending);
    for (const parameter of node.parameters) pushDecorators(parameter.modifiers, pending);
  }
}

/** Queues decorator expressions from a modifier list for outer-scope traversal. */
function pushDecorators(modifiers: readonly Node[] | undefined, pending: Node[]): void {
  if (modifiers === undefined) return;
  for (const modifier of modifiers) {
    if (isDecorator(modifier)) pending.push(modifier.expression);
  }
}

/** Nested non-arrow functions and class blocks bind their own `arguments` rather than `fn`'s. */
function bindsOwnArguments(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isClassStaticBlockDeclaration(node)
  );
}

/** Direct, destructuring, loop and update assignments replace the lexical binding. */
function reassignedIdentifier(name: Identifier): boolean {
  let target: Node = name;
  while (assignmentWrapper(target)) target = target.parent;
  const parent = target.parent;
  if (isBinaryExpression(parent) && parent.left === target) {
    const kind = parent.operatorToken.kind;
    return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
  }
  if (isForInStatement(parent) || isForOfStatement(parent)) return parent.initializer === target;
  return (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
  );
}

/** Transparent expressions and assignment patterns propagate writes to their bound target. */
function assignmentWrapper(target: Node): boolean {
  const parent = target.parent;
  return (
    (transparentExpression(parent) && parent.expression === target) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === target) ||
    (isShorthandPropertyAssignment(parent) && parent.name === target)
  );
}

/** Parentheses, type assertions, non-null markers and satisfies preserve the target reference. */
function transparentExpression(
  node: Node,
): node is Expression & { readonly expression: Expression } {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isTypeAssertion(node) ||
    isNonNullExpression(node) ||
    isSatisfiesExpression(node)
  );
}
