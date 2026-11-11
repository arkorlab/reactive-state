import {
  type BinaryExpression,
  type Block,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isReturnStatement,
  isSetAccessorDeclaration,
  isVariableDeclaration,
  isVoidExpression,
  isArrayLiteralExpression,
  type Node,
  SyntaxKind,
  type VariableStatement,
} from 'typescript/ast';

import { answersLater, isAnswering } from './answers.ts';
import type { WrittenArrayElement } from './framed-array-elements.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedFactoryReturns } from './framed-factory-returns.ts';
import { heldValue, isConstant } from './framed-held-member-writes.ts';
import { framedCondition } from './framed-sources.ts';
import { framedAssignedValues } from './framed-writes.ts';

/** What the functions a descriptor names return, and which of the values it names it hands over. */

/** The operators that hand over one of their operands. */
const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * What a written synchronous function, or a name that holds one, returns as a getter. A name that
 * is assigned before the getter is read may hold what it is assigned instead, as it stands where it
 * is named. Each place that names a function is read once, which keeps a name that holds itself
 * from being followed for good.
 */
export function functionReturns(
  initializer: Expression,
  seen = new Set<Node>(),
): WrittenArrayElement[] {
  if (seen.has(initializer)) return [];
  seen.add(initializer);
  const names: Identifier[] = [];
  const held = heldValue(initializer, names);
  const alternatives = alternativesOf(held);
  const returned =
    alternatives === undefined
      ? bodyReturns(held)
      : alternatives.flatMap((each) => functionReturns(each, seen));
  const replaced = names
    .flatMap((name) => [...variableInitializer(name), ...framedAssignedValues(name)])
    .flatMap((each) => functionReturns(each, seen));
  return distinctElements([...returned, ...replaced]);
}

/** The elements without the repeats that reading one function from two places makes. */
function distinctElements(elements: readonly WrittenArrayElement[]): WrittenArrayElement[] {
  const same = (left: WrittenArrayElement, right: WrittenArrayElement): boolean =>
    left.value === right.value && left.keys.join('.') === right.keys.join('.');
  return elements.filter((each, at) => elements.findIndex((other) => same(other, each)) === at);
}

/**
 * The values a conditional or a logical expression may hand over, the one a written literal
 * condition takes alone; none for any other expression.
 */
export function alternativesOf(
  value: Expression | FunctionDeclaration,
): readonly Expression[] | undefined {
  if (isConditionalExpression(value)) {
    const taken = framedCondition(value.condition);
    if (taken !== undefined) return [taken ? value.whenTrue : value.whenFalse];
    return [value.whenTrue, value.whenFalse];
  }
  if (isBinaryExpression(value) && LOGICAL.has(value.operatorToken.kind)) return operands(value);
  return undefined;
}

/**
 * Whether what an expression is written as, through the constants that hold it, is null or
 * undefined: `null`, `void 0`, an `undefined` no declaration shadows; or a written value, which is
 * neither. None where the compile cannot tell, a name that is assigned among them.
 */
function nullishness(expression: Expression): boolean | undefined {
  const names: Identifier[] = [];
  const value = heldValue(expression, names);
  if (names.some((name) => framedAssignedValues(name).length > 0)) return undefined;
  if (isFunctionDeclaration(value)) return false;
  if (isIdentifier(value))
    return value.text === 'undefined' && frameBindingOf(value) === undefined ? true : undefined;
  if (isVoidExpression(value) || value.kind === SyntaxKind.NullKeyword) return true;
  const written =
    framedCondition(value) !== undefined ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value);
  return written ? false : undefined;
}

/**
 * The operands of a logical expression that it may hand over: where the left is a written
 * literal, the short-circuit rule picks the left, which ends it, or the right.
 */
function operands(value: BinaryExpression): readonly Expression[] {
  const { left, right } = value;
  const kind = value.operatorToken.kind;
  if (kind === SyntaxKind.QuestionQuestionToken) {
    const nullish = nullishness(left);
    if (nullish === undefined) return [left, right];
    return [nullish ? right : left];
  }
  const truth = framedCondition(left);
  if (truth === undefined) return [left, right];
  const taken = truth === (kind === SyntaxKind.AmpersandAmpersandToken) ? right : left;
  return [taken];
}

/** What a written function returns when it is called. */
function bodyReturns(fn: Expression | FunctionDeclaration): WrittenArrayElement[] {
  if (isFunctionDeclaration(fn)) return answersLater(fn) ? [] : returnedValues(fn.body);
  if ((!isArrowFunction(fn) && !isFunctionExpression(fn)) || answersLater(fn)) return [];
  return isBlock(fn.body) ? returnedValues(fn.body) : [{ value: fn.body, keys: [] }];
}

/** The initializer of a variable that is not a constant: what it holds before a write replaces it. */
function variableInitializer(name: Identifier): readonly Expression[] {
  const selected = frameBindingOf(name);
  const declaration = selected?.keys.length === 0 ? selected.binding : undefined;
  const held =
    declaration !== undefined && isVariableDeclaration(declaration) && !isConstant(declaration)
      ? declaration.initializer
      : undefined;
  return held === undefined ? [] : [held];
}

/** What a getter's body may return: by its flow where that is followed, by each `return` else. */
export function returnedValues(body: Block | undefined): WrittenArrayElement[] {
  if (body === undefined) return [];
  const values = framedFactoryReturns(body, constantStatement) ?? writtenReturns(body);
  return values.map((value) => ({ value, keys: [] }));
}

/** Each value a body writes after `return`, those of its nested functions and classes left out. */
function writtenReturns(body: Block): readonly Expression[] {
  const found: Expression[] = [];
  const pending: Node[] = [body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isReturnStatement(node) && node.expression !== undefined) found.push(node.expression);
    node.forEachChild((child) => {
      if (!hasOwnReturns(child)) pending.push(child);
    });
  }
  return found;
}

/** A nested function, a setter among them, or a class: what it returns is not the getter's. */
function hasOwnReturns(node: Node): boolean {
  return (
    isAnswering(node) ||
    isSetAccessorDeclaration(node) ||
    isClassDeclaration(node) ||
    isClassExpression(node)
  );
}

/** A constant declaration, as the object-member readers take it, keeps the body's flow followed. */
function constantStatement(statement: VariableStatement): boolean {
  return /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()));
}
