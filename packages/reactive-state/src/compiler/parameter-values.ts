import {
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isDoStatement,
  isElementAccessExpression,
  isExpressionStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isTypeAssertion,
  isVariableStatement,
  isWhileStatement,
  type Node,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, parametersOf, standsIn } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { readsOf } from './local-module-reads.ts';
import { hoistedIn, isBlockScoped, withinFunction } from './scope.ts';
import { writtenBy } from './written.ts';

/** A definite top-level replacement of a parameter before one of its reads. */
export interface ParameterValue {
  readonly value: Expression;
  readonly statement: Statement;
}

/** Peels parentheses and TypeScript assertion wrappers, including `<T>expr`. */
function peelValue(node: Expression): Expression {
  let current = unwrapped(node);
  while (isTypeAssertion(current)) {
    current = unwrapped(current.expression);
  }
  return current;
}

/** A plain assignment or `var` initializer that certainly ran before `name` was read. */
export function parameterValue(
  fn: Answering,
  declared: Identifier,
  name: Identifier,
): ParameterValue | undefined {
  if (fn.body === undefined || !isBlock(fn.body) || withinFunction(name, fn)) {
    return undefined;
  }
  const isRead = readsOf(declared, fn);
  let found: ParameterValue | undefined;
  for (const statement of fn.body.statements) {
    if (statement.end > name.pos) {
      break;
    }
    const value = replacementIn(statement, declared.text);
    if (value !== undefined) {
      found = { value, statement };
    }
  }
  return found === undefined || uncertainReplacement(fn, name, found, isRead) ? undefined : found;
}

/** Reads of the replacement's value, including closures whose bodies may run after it was set. */
export function readsReplacement(
  fn: Answering,
  replacement: ParameterValue,
): (name: Identifier) => boolean {
  return (name) =>
    !standsIn(name, fn) || name.pos >= replacement.value.end || withinFunction(name, fn);
}

/** A direct assignment, past casts, or the last initialized `var` of the same binding. */
function replacementIn(statement: Statement, name: string): Expression | undefined {
  if (isVariableStatement(statement) && !isBlockScoped(statement.declarationList)) {
    return statement.declarationList.declarations.findLast(
      (each) =>
        isIdentifier(each.name) && each.name.text === name && each.initializer !== undefined,
    )?.initializer;
  }
  if (!isExpressionStatement(statement)) {
    return undefined;
  }
  const expression = peelValue(statement.expression);
  if (!isBinaryExpression(expression) || expression.operatorToken.kind !== SyntaxKind.EqualsToken) {
    return undefined;
  }
  const target = peelValue(expression.left);
  return isIdentifier(target) && target.text === name ? expression.right : undefined;
}

/** A later conditional replacement or a closure's assignment prevents proving the binding's value. */
function uncertainReplacement(
  fn: Answering,
  name: Identifier,
  replacement: ParameterValue,
  isRead: (node: Node) => node is Identifier,
): boolean {
  const laterVar = hoistedIn(fn.body === undefined ? [] : [fn.body]).some((declaration) => {
    return (
      isIdentifier(declaration.name) &&
      declaration.name.text === name.text &&
      (declaration.initializer !== undefined ||
        isForInStatement(declaration.parent.parent) ||
        isForOfStatement(declaration.parent.parent)) &&
      precedesRead(declaration, name, replacement, fn)
    );
  });
  if (laterVar) {
    return true;
  }
  const visit = (node: Node): boolean => {
    const target = isCallExpression(node) ? undefined : writtenBy(node);
    if (
      target !== undefined &&
      assignsBinding(target, isRead) &&
      (precedesRead(node, name, replacement, fn) || withinFunction(node, fn))
    ) {
      return true;
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return (
    parametersOf(fn).some((parameter) => visit(parameter)) ||
    (fn.body !== undefined && visit(fn.body))
  );
}

/** Whether `write` can run after `replacement` and before `read`, including an earlier iteration. */
function precedesRead(
  write: Node,
  read: Identifier,
  replacement: ParameterValue,
  fn: Answering,
): boolean {
  return (
    write.pos >= replacement.value.end && (write.pos < read.pos || repeatsBefore(write, read, fn))
  );
}

/** Whether an enclosing loop can carry `write` into a subsequent execution of `read`. */
function repeatsBefore(write: Node, read: Node, fn: Answering): boolean {
  for (let each = read; each !== fn; each = each.parent) {
    const parent = each.parent;
    if (!isLoop(parent) || write.pos < parent.pos || write.end > parent.end) {
      continue;
    }
    const once =
      (isForStatement(parent) &&
        parent.initializer?.pos === each.pos &&
        parent.initializer.end === each.end) ||
      ((isForOfStatement(parent) || isForInStatement(parent)) &&
        parent.expression.pos === each.pos &&
        parent.expression.end === each.end);
    if (!once) {
      return true;
    }
  }
  return false;
}

/** Whether `node` is a loop statement. */
function isLoop(node: Node): boolean {
  return (
    isForStatement(node) ||
    isForOfStatement(node) ||
    isForInStatement(node) ||
    isWhileStatement(node) ||
    isDoStatement(node)
  );
}

/** A direct binding write, including destructuring targets, but no write through a member. */
function assignsBinding(target: Node, isRead: (node: Node) => node is Identifier): boolean {
  let value = target;
  while (isPropertyAssignment(value)) {
    value = value.initializer;
  }
  if (isIdentifier(value)) {
    return isRead(value);
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    return false;
  }
  if (isShorthandPropertyAssignment(value)) {
    return isRead(value.name);
  }
  return value.forEachChild((child) => (assignsBinding(child, isRead) ? true : undefined)) === true;
}
