import {
  type Expression,
  type Identifier,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isEmptyStatement,
  isIdentifier,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { callbackCreationEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { declarationOf, type Declared } from './framed.ts';
import { metadataCallee } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { freeReads, isBlockScoped } from './scope.ts';
import { writtenOf } from './throw-shapes.ts';

/** A known synchronous call whose first return reads a lexical binding before initialization. */
export function tdzCallThrows(node: Node, outer: Resolve | undefined): boolean {
  if (
    !isCallExpression(node) ||
    node.arguments.some((argument) => isSpreadElement(argument) || callbackCreationEffect(argument))
  ) {
    return false;
  }
  const value = writtenOf(node.expression, outer);
  const fn = metadataCallee(node.expression) ?? metadataCallee(value);
  if (fn === undefined || !isAnswering(fn) || calleeUncertain(value, node)) {
    return false;
  }
  const read = firstReturnedName(fn);
  const declaration = read === undefined ? undefined : declarationOf(read);
  if (
    read === undefined ||
    declaration === undefined ||
    !lexicalDeclaration(declaration) ||
    !readsDeclaration(read, declaration)
  ) {
    return false;
  }
  const frame = executionFrame(declaration);
  if (frame === fn) {
    return declaration.end > read.pos;
  }
  return (
    frame === executionFrame(node) && scopeContains(declaration, node) && declaration.end > node.pos
  );
}

/** Only an unconditional bare first return proves the captured read executes. */
function firstReturnedName(fn: Answering): Identifier | undefined {
  if (
    answersLater(fn) ||
    fn.body === undefined ||
    parametersOf(fn).some(
      (parameter) => !isIdentifier(parameter.name) || parameter.initializer !== undefined,
    )
  ) {
    return undefined;
  }
  let expression: Expression | undefined;
  if (isBlock(fn.body)) {
    const first = fn.body.statements.find((statement) => !isEmptyStatement(statement));
    expression = first !== undefined && isReturnStatement(first) ? first.expression : undefined;
  } else {
    expression = fn.body;
  }
  if (expression === undefined) {
    return undefined;
  }
  const value = unwrapped(expression);
  return isIdentifier(value) ? value : undefined;
}

/** Var and function declarations are hoisted; lexical variables and classes initialize in order. */
function lexicalDeclaration(declaration: Declared): boolean {
  return (
    isClassDeclaration(declaration) ||
    (isVariableDeclaration(declaration) &&
      isVariableDeclarationList(declaration.parent) &&
      isBlockScoped(declaration.parent))
  );
}

/** A nested loop, catch or class binding must not be mistaken for an outer declaration. */
function readsDeclaration(read: Identifier, declaration: Declared): boolean {
  const scope = lexicalScope(declaration);
  for (let each: Node = read; !isSourceFile(each); each = each.parent) {
    if (each.parent === scope) {
      return freeReads(each).includes(read);
    }
  }
  return false;
}

/** The source scope that instantiates this block declaration. */
function lexicalScope(declaration: Declared): Node {
  let scope = declaration.parent;
  while (!isBlock(scope) && !isSourceFile(scope)) {
    scope = scope.parent;
  }
  return scope;
}

/** A captured declaration is relevant only while its own lexical scope is executing. */
function scopeContains(declaration: Declared, node: Node): boolean {
  const scope = lexicalScope(declaration);
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (each.parent === scope) {
      return true;
    }
  }
  return false;
}

/** Deferred function bodies and instance fields have their own execution order. */
function executionFrame(node: Node): Node {
  for (let each = node.parent; ; each = each.parent) {
    if (
      isSourceFile(each) ||
      isAnswering(each) ||
      isConstructorDeclaration(each) ||
      isSetAccessorDeclaration(each) ||
      isPropertyDeclaration(each)
    ) {
      return each;
    }
  }
}
