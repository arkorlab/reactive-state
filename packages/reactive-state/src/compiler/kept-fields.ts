import {
  type ClassDeclaration,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isMetaProperty,
  isNewExpression,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  isVoidExpression,
  type Node,
  type PropertyDeclaration,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { declarationOf } from './framed.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Instance fields whose private class is constructed only as its module loads, without escaping. */
const STARTUP = new WeakMap<ClassDeclaration, boolean>();

/** Whether an instance field runs only in private, direct constructions at module startup. */
export function startupField(field: PropertyDeclaration): boolean {
  const owner = field.parent;
  if (!isClassDeclaration(owner)) {
    return false;
  }
  let startup = STARTUP.get(owner);
  if (startup === undefined) {
    startup = privateStartupClass(owner);
    STARTUP.set(owner, startup);
  }
  return startup;
}

/** Whether a class exposes only primitive data through instances made once as the module loads. */
function privateStartupClass(owner: ClassDeclaration): boolean {
  if (
    owner.name === undefined ||
    !isSourceFile(owner.parent) ||
    owner.heritageClauses !== undefined ||
    (owner.modifiers?.length ?? 0) > 0
  ) {
    return false;
  }
  const fields = primitiveFields(owner);
  if (fields === undefined || hasReceiver(owner)) {
    return false;
  }
  const instances = new Set<VariableDeclaration>();
  const validClass = everyReference(owner.name, (name) => {
    const instance = startupInstance(name);
    if (instance === undefined) {
      return false;
    }
    instances.add(instance);
    return true;
  });
  if (!validClass || instances.size === 0) {
    return false;
  }
  for (const instance of instances) {
    if (
      !isIdentifier(instance.name) ||
      !everyReference(instance.name, (name) => readsPrimitive(name, fields))
    ) {
      return false;
    }
  }
  return true;
}

/** The class's own, noncomputed data fields, each of a value shown to be primitive. */
function primitiveFields(owner: ClassDeclaration): ReadonlySet<string> | undefined {
  const fields = new Set<string>();
  for (const member of owner.members) {
    if (
      !isPropertyDeclaration(member) ||
      member.initializer === undefined ||
      !primitiveResult(member.initializer) ||
      member.modifiers?.some((modifier) => {
        return [
          SyntaxKind.AccessorKeyword,
          SyntaxKind.Decorator,
          SyntaxKind.StaticKeyword,
        ].includes(modifier.kind);
      }) === true
    ) {
      return undefined;
    }
    const name = dataName(member.name);
    if (name === undefined || name === 'constructor' || fields.has(name)) {
      return undefined;
    }
    fields.add(name);
  }
  return fields;
}

/** A value whose result cannot retain the instance, its constructor or another mutable holder. */
function primitiveResult(expression: Expression): boolean {
  const value = unwrapped(expression);
  return (
    isStringLiteral(value) ||
    isNumericLiteral(value) ||
    isBigIntLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isTemplateExpression(value) ||
    isPrefixUnaryExpression(value) ||
    isPostfixUnaryExpression(value) ||
    isVoidExpression(value) ||
    isTypeOfExpression(value) ||
    [SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword].includes(value.kind)
  );
}

/** Whether any initializer could hand the instance or its constructor to other code. */
function hasReceiver(owner: ClassDeclaration): boolean {
  const pending: Node[] = [owner];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      node.kind === SyntaxKind.ThisKeyword ||
      node.kind === SyntaxKind.SuperKeyword ||
      isMetaProperty(node)
    ) {
      return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether every runtime reference to this lexical declaration has the proven use. */
function everyReference(name: Identifier, permits: (reference: Identifier) => boolean): boolean {
  const binding = declarationOf(name);
  const pending: Node[] = [name.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    if (
      node !== name &&
      isIdentifier(node) &&
      node.text === name.text &&
      readsBinding(node) &&
      declarationOf(node) === binding &&
      !permits(node)
    ) {
      return false;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** The private module constant initialized directly by this argument-free construction. */
function startupInstance(name: Identifier): VariableDeclaration | undefined {
  const made = name.parent;
  if (!isNewExpression(made) || made.expression !== name || (made.arguments?.length ?? 0) > 0) {
    return undefined;
  }
  const declaration = made.parent;
  if (!isVariableDeclaration(declaration) || declaration.initializer !== made) {
    return undefined;
  }
  const list = declaration.parent;
  if (!isVariableDeclarationList(list) || !/^const\s/u.test(list.getText())) {
    return undefined;
  }
  const statement = list.parent;
  return isVariableStatement(statement) &&
    isSourceFile(statement.parent) &&
    (statement.modifiers?.length ?? 0) === 0
    ? declaration
    : undefined;
}

/** Whether a reference reads one of the instance's primitive own data fields without writing it. */
function readsPrimitive(name: Identifier, fields: ReadonlySet<string>): boolean {
  const access = name.parent;
  let key: string | undefined;
  if (isPropertyAccessExpression(access)) {
    key = access.name.text;
  } else if (
    isElementAccessExpression(access) &&
    (isStringLiteral(access.argumentExpression) || isNumericLiteral(access.argumentExpression))
  ) {
    key = access.argumentExpression.text;
  }
  return (
    key !== undefined &&
    fields.has(key) &&
    (isPropertyAccessExpression(access) || isElementAccessExpression(access)) &&
    access.expression === name &&
    !writesOrCalls(access)
  );
}

/** The name of a noncomputed declaration or a literal element read. */
function dataName(node: Node): string | undefined {
  return isIdentifier(node) || isStringLiteral(node) || isNumericLiteral(node)
    ? node.text
    : undefined;
}

/** Whether an access stands as a write target, including within an assignment pattern. */
function writesOrCalls(access: Node): boolean {
  let node = access;
  while (carriesTarget(node.parent, node)) {
    node = node.parent;
  }
  const parent = node.parent;
  if (isBinaryExpression(parent) && parent.left === node) {
    return (
      parent.operatorToken.kind >= SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= SyntaxKind.LastAssignment
    );
  }
  return (
    isDeleteExpression(parent) ||
    isPostfixUnaryExpression(parent) ||
    (isPrefixUnaryExpression(parent) &&
      [SyntaxKind.MinusMinusToken, SyntaxKind.PlusPlusToken].includes(parent.operator)) ||
    ((isForInStatement(parent) || isForOfStatement(parent)) && parent.initializer === node) ||
    ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === node)
  );
}

/** Wrappers and patterns through which an assignment target remains a target. */
function carriesTarget(parent: Node, child: Node): boolean {
  return (
    isParenthesizedExpression(parent) ||
    isAsExpression(parent) ||
    isSatisfiesExpression(parent) ||
    isNonNullExpression(parent) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === child)
  );
}
