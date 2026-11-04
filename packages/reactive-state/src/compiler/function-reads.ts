import {
  type Expression,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassExpression,
  isConstructorTypeNode,
  isElementAccessExpression,
  isFunctionExpression,
  isFunctionTypeNode,
  isIdentifier,
  isMethodDeclaration,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
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
 * function of, nor the name of an entry of an object, which no bundle shortens. `Function`'s own,
 * `Function.prototype.toString`, makes code of text besides, which no shared module reads
 * (`code-globals.ts`).
 */
export function functionRead(node: Node): string | undefined {
  const read = memberRead(node);
  if (read !== undefined) {
    const of = unwrapped(read.of);
    const named = read.name === 'name' && isPropertyAccessExpression(of);
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
 * an object it writes, `helpers.pick` of `const helpers = { pick() { … } }`; what a name around it
 * is declared of — a function, a class, a variable of one (`declarationOf`), in turn — or a
 * parameter said to be one, `(pick: () => string)`.
 */
function isFunction(node: Expression, seen: Set<Node>): boolean {
  if (isArrowFunction(node) || isFunctionExpression(node) || isClassExpression(node)) {
    return true;
  }
  if (isPropertyAccessExpression(node)) {
    return isEntryFunction(unwrapped(node.expression), node.name.text, seen);
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

/** Whether `holder`, a name of an object the code writes, holds a function as its entry `name`. */
function isEntryFunction(holder: Expression, name: string, seen: Set<Node>): boolean {
  const declared = isIdentifier(holder) ? declarationOf(holder) : undefined;
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    declared.initializer === undefined ||
    seen.has(declared)
  ) {
    return false;
  }
  seen.add(declared);
  const value = unwrapped(declared.initializer);
  return (
    isObjectLiteralExpression(value) &&
    value.properties.some((property) => {
      if (isMethodDeclaration(property)) {
        return keyOf(property.name) === name;
      }
      if (isPropertyAssignment(property)) {
        return keyOf(property.name) === name && isFunction(unwrapped(property.initializer), seen);
      }
      return (
        isShorthandPropertyAssignment(property) &&
        isIdentifier(property.name) &&
        property.name.text === name &&
        isFunction(property.name, seen)
      );
    })
  );
}

/** The name of an entry the code writes: of a name, or text; none of another. */
function keyOf(name: PropertyName): string | undefined {
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
