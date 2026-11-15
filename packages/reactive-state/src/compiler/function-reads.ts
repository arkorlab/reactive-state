import {
  type ElementAccessExpression,
  type Expression,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassExpression,
  isComputedPropertyName,
  isConstructorTypeNode,
  isElementAccessExpression,
  isFunctionExpression,
  isFunctionTypeNode,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { globalPathOf, patternKey } from './code-globals.ts';
import { declarationOf, namesType, parameterOf } from './framed.ts';

/**
 * What of a shared module's code reads what each side's bundle writes otherwise of a function of its
 * (`settled.ts`): its source, which a bundle's transforms and its minifier write anew, and its name,
 * which a minifier may shorten — `pick.toString()`, `String(pick)`, `pick.name`.
 */

/** The members of a function each side's bundle writes otherwise: its source, its name. */
const BUNDLED: ReadonlySet<string> = new Set(['name', 'toString']);

/** The types a parameter is said to be a function of by their names: `Function`, and its kin. */
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'CallableFunction',
  'Function',
  'NewableFunction',
]);

/** The operators that make text of a function beside them: `+`, `+=`. */
const ADDING: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.PlusEqualsToken, SyntaxKind.PlusToken]);

/**
 * What of `node` reads what each side's bundle writes otherwise of a function the code shows it
 * writes (`isFunction`): its source — `toString` of it, `String(pick)`, a template, `pick + ''` — or
 * the name it is declared by, `pick.name`; none of another, nor of a value the code shows no
 * function of, nor the name of an entry of an object, which no bundle shortens.
 */
export function functionRead(node: Node): string | undefined {
  const read = memberRead(node);
  if (read !== undefined) {
    const of = unwrapped(read.of);
    const named =
      read.name === 'name' && (isPropertyAccessExpression(of) || isElementAccessExpression(of));
    return !named && BUNDLED.has(read.name) && isFunction(of, new Set())
      ? `reads \`${read.name}\` of a function, which each side's bundle writes otherwise`
      : undefined;
  }
  const written = textOf(node);
  return written !== undefined && isFunction(unwrapped(written), new Set())
    ? "writes a function as text, which each side's bundle writes otherwise"
    : undefined;
}

/**
 * What `node` reads a member of, by the member's name: `pick.name`, `pick['toString']`, `const {
 * name } = pick`; none of another node.
 */
function memberRead(node: Node): { readonly name: string; readonly of: Expression } | undefined {
  if (isPropertyAccessExpression(node)) {
    return { name: node.name.text, of: node.expression };
  }
  if (isElementAccessExpression(node)) {
    const name = literalName(node);
    return name === undefined ? undefined : { name, of: node.expression };
  }
  if (!isBindingElement(node) || !isObjectBindingPattern(node.parent)) {
    return undefined;
  }
  const declaration = node.parent.parent;
  const name = patternKey(node);
  return name !== undefined &&
    isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined
    ? { name, of: declaration.initializer }
    : undefined;
}

/** What `node` writes as text where it writes it so: `String`'s argument, a template's, an operand of `+`. */
function textOf(node: Node): Expression | undefined {
  if (isCallExpression(node) && globalPathOf(unwrapped(node.expression))?.join('.') === 'String') {
    return node.arguments[0];
  }
  if (isTemplateExpression(node)) {
    return node.templateSpans.find((span) => isFunction(unwrapped(span.expression), new Set()))
      ?.expression;
  }
  if (!isBinaryExpression(node) || !ADDING.has(node.operatorToken.kind)) {
    return undefined;
  }
  return isFunction(unwrapped(node.left), new Set()) ? node.left : node.right;
}

/**
 * Whether `node` is a function the code shows it writes: an arrow, a function, a class; an entry of
 * an object it writes (`helpers.pick`, `helpers['pick']`); what a name around it is declared of; or
 * a parameter said to be one, `(pick: () => string)`.
 */
function isFunction(node: Expression, seen: Set<Node>): boolean {
  if (isArrowFunction(node) || isFunctionExpression(node) || isClassExpression(node)) {
    return true;
  }
  if (isPropertyAccessExpression(node)) {
    return isEntryFunction(unwrapped(node.expression), node.name.text, seen);
  }
  if (isElementAccessExpression(node)) {
    return isElementEntryFunction(node, seen);
  }
  if (!isIdentifier(node)) {
    return false;
  }
  const declared = declarationOf(node);
  if (declared === undefined) {
    return isFunctionType(parameterOf(node)?.type);
  }
  if (seen.has(declared)) {
    return false;
  }
  seen.add(declared);
  return (
    !isVariableDeclaration(declared) ||
    isFunctionType(declared.type) ||
    (declared.initializer !== undefined && isFunction(unwrapped(declared.initializer), seen))
  );
}

/** Whether bracket access `node` reads a function entry from a written object literal. */
function isElementEntryFunction(node: ElementAccessExpression, seen: Set<Node>): boolean {
  const holder = unwrapped(node.expression);
  const key = elementKey(node);
  if (key !== undefined) {
    return isEntryFunction(holder, key, seen);
  }
  const object = holderObject(holder, seen);
  return object !== undefined && object.properties.some((each) => propertyIsFunction(each, seen));
}

/** Whether `holder`, an object literal or name of one, holds a function as its entry `name`. */
function isEntryFunction(holder: Expression, name: string, seen: Set<Node>): boolean {
  const object = holderObject(holder, seen);
  if (object === undefined) {
    return false;
  }
  let matched = false;
  for (const property of object.properties) {
    if (propertyKey(property) === name) {
      matched = propertyIsFunction(property, seen);
    }
  }
  return matched;
}

/** Resolves an inline or lexically bound object literal expression. */
function holderObject(holder: Expression, seen: Set<Node>): ObjectLiteralExpression | undefined {
  if (isObjectLiteralExpression(holder)) {
    return holder;
  }
  const declared = isIdentifier(holder) ? declarationOf(holder) : undefined;
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    declared.initializer === undefined ||
    seen.has(declared)
  ) {
    return undefined;
  }
  seen.add(declared);
  return holderObject(unwrapped(declared.initializer), seen);
}

/** Whether `property` of an object literal defines a function value. */
function propertyIsFunction(property: ObjectLiteralElementLike, seen: Set<Node>): boolean {
  if (isMethodDeclaration(property)) {
    return true;
  }
  if (isPropertyAssignment(property)) {
    return isFunction(unwrapped(property.initializer), seen);
  }
  return (
    isShorthandPropertyAssignment(property) &&
    isIdentifier(property.name) &&
    isFunction(property.name, seen)
  );
}

/** Static property key of an object literal element. */
function propertyKey(property: ObjectLiteralElementLike): string | undefined {
  if (isShorthandPropertyAssignment(property)) {
    return isIdentifier(property.name) ? property.name.text : undefined;
  }
  return 'name' in property && property.name !== undefined ? keyOf(property.name) : undefined;
}

/** Static key of an element access expression, including string, template and numeric literals. */
function elementKey(node: ElementAccessExpression): string | undefined {
  const name = literalName(node);
  if (name !== undefined) {
    return name;
  }
  const argument = unwrapped(node.argumentExpression);
  return isNumericLiteral(argument) ? String(Number(argument.text)) : undefined;
}

/** The name of an entry the code writes: of a name, text, or a number; none of another. */
function keyOf(name: PropertyName): string | undefined {
  if (isComputedPropertyName(name)) {
    const value = unwrapped(name.expression);
    if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
      return value.text;
    }
    return isNumericLiteral(value) ? String(Number(value.text)) : undefined;
  }
  if (isNumericLiteral(name)) {
    return String(Number(name.text));
  }
  return isIdentifier(name) || isStringLiteral(name) ? name.text : undefined;
}

/**
 * Whether `type`, written, says a function: a function's type, `() => string`, a class's,
 * `new () => object`, or `Function`'s and its kin's (`FUNCTION_TYPES`), in a union too.
 */
function isFunctionType(type: TypeNode | undefined): boolean {
  return (
    type !== undefined &&
    (isFunctionTypeNode(type) || isConstructorTypeNode(type) || namesType(type, FUNCTION_TYPES))
  );
}
