import {
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isVariableStatement,
  type Node,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, standsIn } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { readsOf } from './local-module-reads.ts';
import { hoistedIn, isBlockScoped, withinFunction } from './scope.ts';
import { writtenBy } from './written.ts';

/** A definite top-level replacement of a parameter before one of its reads. */
export interface ParameterValue {
  readonly value: Expression;
  readonly statement: Statement;
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
  const expression = unwrapped(statement.expression);
  if (!isBinaryExpression(expression) || expression.operatorToken.kind !== SyntaxKind.EqualsToken) {
    return undefined;
  }
  const target = unwrapped(expression.left);
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
      declaration.pos >= replacement.value.end &&
      declaration.pos < name.pos
    );
  });
  if (laterVar) {
    return true;
  }
  const visit = (node: Node): boolean => {
    const target = isCallExpression(node) ? undefined : writtenBy(node);
    if (target !== undefined && assignsBinding(target, isRead)) {
      const later = node.pos >= replacement.value.end && node.pos < name.pos;
      if (later || withinFunction(node, fn)) {
        return true;
      }
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return fn.body !== undefined && visit(fn.body);
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
