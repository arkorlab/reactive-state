import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  type ObjectLiteralElementLike,
  SyntaxKind,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { globalPathOf, patternKey } from './code-globals.ts';
import { initializerOf } from './framed.ts';
import { constantValue } from './numbers.ts';
import { platformInitializer } from './platform-inputs.ts';

/**
 * What of a shared module's code reads the time through what the platform makes (`settled.ts`): a
 * `File` made of no `lastModified`, which it takes of now, and an event's `timeStamp`, of when the
 * event was made.
 */

/**
 * What of `node` reads the time through what the platform makes: `new File(…)` of no
 * `lastModified` the code writes, `new File([], 'x')`; `timeStamp` of an event the code makes,
 * `new Event('x').timeStamp` — none of another.
 */
export function timedMaking(node: Node): string | undefined {
  if (isNewExpression(node) && isClass(node.expression, 'File') && !isDated(node)) {
    return 'makes a `File` of no `lastModified`, which it takes of the time';
  }
  return eventReadsClock(node)
    ? "reads an event's `timeStamp`, of the time it was made"
    : undefined;
}

/** Whether `node` reads the creation time of an event the code makes. */
export function eventReadsClock(node: Node): boolean {
  const read = memberRead(node);
  return read?.name === 'timeStamp' && isEvent(unwrapped(read.of), new Set());
}

/** Whether `node` names the global class `name`. */
function isClass(node: Expression, name: string): boolean {
  return globalPathOf(unwrapped(node))?.join('.') === name;
}

/**
 * Whether `made`, a `File`, is made of a `lastModified` the code writes: of options it writes there,
 * or variables around it are declared of, of no spread, whose last `lastModified` is shown defined.
 */
function isDated(made: NewExpression): boolean {
  if (made.arguments?.some((each) => isSpreadElement(each)) === true) {
    return false;
  }
  const options = made.arguments?.[2];
  const value = options === undefined ? undefined : declaredValue(options, made);
  if (
    value === undefined ||
    !isObjectLiteralExpression(value) ||
    value.properties.some((each) => readsOptionsCode(each, made))
  ) {
    return false;
  }
  let dated = false;
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      return false;
    }
    const key = keyOf(property.name, made);
    if (key === undefined) {
      dated = false;
    } else if (key === 'lastModified') {
      dated = propertyDated(property, made);
    }
  }
  return dated;
}

/** Accessors or a custom prototype whose option reads may alter `lastModified`. */
function readsOptionsCode(property: ObjectLiteralElementLike, before: Node): boolean {
  return (
    isGetAccessorDeclaration(property) ||
    isSetAccessorDeclaration(property) ||
    (isPropertyAssignment(property) && keyOf(property.name, before) === '__proto__')
  );
}

/** Whether a `lastModified` property writes a timestamp shown defined at `before`. */
function propertyDated(property: ObjectLiteralElementLike, before: Node): boolean {
  if (isPropertyAssignment(property)) {
    return definedValue(property.initializer, before);
  }
  return (
    isShorthandPropertyAssignment(property) &&
    isIdentifier(property.name) &&
    definedValue(property.name, before)
  );
}

/** The name of an entry the code writes: of a name, or text; none of another. */
function keyOf(name: Node, before: Node): string | undefined {
  if (
    isIdentifier(name) ||
    isStringLiteral(name) ||
    isNoSubstitutionTemplateLiteral(name) ||
    isNumericLiteral(name)
  ) {
    return name.text;
  }
  const key = isComputedPropertyName(name)
    ? constantValue(name.expression, (value) => platformInitializer(value, before))
    : undefined;
  return key === undefined ? undefined : String(key);
}

/** What an unchanged variable around `before` is declared of, in turn, without looping on aliases. */
function declaredValue(node: Expression, before: Node): Expression {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = platformInitializer(value, before);
    if (declared === undefined) {
      break;
    }
    value = unwrapped(declared);
  }
  return value;
}

/**
 * Whether a timestamp expression is shown defined — and non-null where `nullable` is false — so a
 * File cannot default `lastModified` to the current time across `??` fallbacks.
 */
function definedValue(
  node: Expression,
  before: Node,
  seen = new Set<Expression>(),
  nullable = true,
): boolean {
  const value = declaredValue(node, before);
  if (seen.has(value)) {
    return false;
  }
  const following = new Set([...seen, value]);
  if (constantValue(value, (name) => platformInitializer(name, before)) !== undefined) {
    return true;
  }
  if (isConditionalExpression(value)) {
    return (
      definedValue(value.whenTrue, before, following, nullable) &&
      definedValue(value.whenFalse, before, following, nullable)
    );
  }
  if (isBinaryExpression(value)) {
    return definedBinary(value, before, following, nullable);
  }
  if (isCallExpression(value)) {
    return ['Boolean', 'Number', 'String'].includes(
      globalPathOf(unwrapped(value.expression))?.join('.') ?? '',
    );
  }
  return definedLiteral(value, nullable);
}

/** Literals and constructions that always supply a value, excluding `null` when `!nullable`. */
function definedLiteral(value: Expression, nullable: boolean): boolean {
  return (
    (nullable && value.kind === SyntaxKind.NullKeyword) ||
    [SyntaxKind.FalseKeyword, SyntaxKind.TrueKeyword].includes(value.kind) ||
    isBigIntLiteral(value) ||
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value) ||
    isRegularExpressionLiteral(value) ||
    isNewExpression(value) ||
    isTemplateExpression(value)
  );
}

/** Whether an expression selecting a value has no branch that may answer undefined. */
function definedBinary(
  value: Expression,
  before: Node,
  seen: Set<Expression>,
  nullable: boolean,
): boolean {
  if (!isBinaryExpression(value)) {
    return false;
  }
  if (value.operatorToken.kind === SyntaxKind.QuestionQuestionToken) {
    return (
      definedValue(value.left, before, seen, false) ||
      definedValue(value.right, before, seen, nullable)
    );
  }
  return (
    value.operatorToken.kind === SyntaxKind.BarBarToken &&
    definedValue(value.right, before, seen, nullable)
  );
}

/**
 * What `node` reads a member of, by the member's name: `event.timeStamp`, `event['timeStamp']`,
 * `const { timeStamp } = event`; none of another node.
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

/**
 * Whether `node` is an event the code makes: `new Event('x')`, or what a variable around it is
 * declared of (`initializerOf`), in turn.
 */
function isEvent(node: Expression, seen: Set<Identifier>): boolean {
  if (isNewExpression(node)) {
    return isClass(node.expression, 'Event');
  }
  if (!isIdentifier(node) || seen.has(node)) {
    return false;
  }
  seen.add(node);
  const declared = initializerOf(node);
  return declared !== undefined && isEvent(unwrapped(declared), seen);
}
