import {
  type Expression,
  isBinaryExpression,
  isBlock,
  isComputedPropertyName,
  isExpression,
  isFunctionDeclaration,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isTemplateExpression,
  isTaggedTemplateExpression,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { runsLater } from './deferred-syntax.ts';
import { metadataCallee } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { enumerationKey } from './throw-keys.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { interveningEvaluation } from './written-evaluation.ts';

const PRIMITIVE_HOOK = 'Symbol.toPrimitive';

/** Binary operators that convert their operands before producing an ordinary primitive result. */
const CONVERTING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandToken,
  SyntaxKind.AsteriskAsteriskToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.BarToken,
  SyntaxKind.CaretToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.LessThanLessThanToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.MinusToken,
  SyntaxKind.PercentToken,
  SyntaxKind.PlusToken,
  SyntaxKind.SlashToken,
]);

/** A written object's first guaranteed primitive-conversion function, without executing its code. */
export function coercionFunction(node: Node, resolve: Resolve | undefined): Node | undefined {
  if (
    isPrefixUnaryExpression(node) &&
    [SyntaxKind.MinusToken, SyntaxKind.PlusToken, SyntaxKind.TildeToken].includes(node.operator)
  ) {
    return objectHook(node.operand, node, false, resolve);
  }
  if (isTemplateExpression(node) && !isTaggedTemplateExpression(node.parent)) {
    const first = node.templateSpans[0];
    return first === undefined ? undefined : objectHook(first.expression, node, true, resolve);
  }
  if (!isBinaryExpression(node) || !CONVERTING.has(node.operatorToken.kind)) {
    return undefined;
  }
  if (!quietCreation(node.right)) {
    return undefined;
  }
  const left = objectHook(node.left, node, false, resolve);
  return (
    left ??
    (primitiveOf(node.left, resolve) === undefined
      ? undefined
      : objectHook(node.right, node, false, resolve))
  );
}

/** Own hooks of a plain literal, with unknown prototypes, properties and intervening effects opaque. */
function objectHook(
  expression: Expression,
  operation: Expression,
  stringHint: boolean,
  resolve: Resolve | undefined,
): Node | undefined {
  const value = writtenOf(expression, resolve);
  if (!isObjectLiteralExpression(value) || interveningEvaluation(value, operation)) {
    return undefined;
  }
  const hooks = ownHooks(value, resolve);
  if (hooks === undefined) {
    return undefined;
  }
  const exotic = hooks.get(PRIMITIVE_HOOK);
  if (exotic !== undefined) {
    return sourceFunction(exotic, resolve);
  }
  if (earlierApplication(operation)) {
    return undefined;
  }
  const first = hooks.get(stringHint ? 'toString' : 'valueOf');
  if (first !== undefined) {
    return sourceFunction(first, resolve);
  }
  // The ordinary Object valueOf returns the receiver, so numeric/default conversion next calls toString.
  return stringHint ? undefined : sourceFunction(hooks.get('toString'), resolve);
}

/** Final own data/method entries; accessors and computed unknown keys keep selection unknown. */
function ownHooks(
  object: ObjectLiteralExpression,
  resolve: Resolve | undefined,
): Map<string, Node> | undefined {
  const hooks = new Map<string, Node>();
  for (const property of object.properties) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const key =
      isComputedPropertyName(property.name) &&
      globalCalleePath(property.name.expression, resolve)?.join('.') === PRIMITIVE_HOOK
        ? PRIMITIVE_HOOK
        : enumerationKey(property.name, resolve);
    if (typeof key !== 'string' || key === '__proto__') {
      return undefined;
    }
    if (isPropertyAssignment(property) && quietCreation(property.initializer)) {
      hooks.set(key, property.initializer);
    } else if (isMethodDeclaration(property)) {
      hooks.set(key, property);
    } else {
      return undefined;
    }
  }
  return hooks;
}

/** A data function alias or a literal method, leaving noncallable and returned-object cases opaque. */
function sourceFunction(node: Node | undefined, resolve: Resolve | undefined): Node | undefined {
  const value = node !== undefined && isExpression(node) ? writtenOf(node, resolve) : node;
  const fn = value !== undefined && isExpression(value) ? (metadataCallee(value) ?? value) : value;
  return fn !== undefined && isAnswering(fn) ? fn : undefined;
}

/** Function bodies are deferred; calls, reads and computed creation effects stay opaque. */
function quietCreation(node: Node): boolean {
  if (isAnswering(node)) {
    return true;
  }
  if (conversionRunsCode(node)) {
    return false;
  }
  if (isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      return (
        !isSpreadAssignment(property) &&
        (!isComputedPropertyName(property.name) ||
          globalCalleePath(property.name.expression, undefined)?.join('.') === PRIMITIVE_HOOK) &&
        (isMethodDeclaration(property) ||
          (isPropertyAssignment(property) && quietCreation(property.initializer)))
      );
    });
  }
  if (isExpression(node) && globalCalleePath(node, undefined) !== undefined) {
    return true;
  }
  if (
    [
      SyntaxKind.CallExpression,
      SyntaxKind.ElementAccessExpression,
      SyntaxKind.NewExpression,
      SyntaxKind.PropertyAccessExpression,
      SyntaxKind.TaggedTemplateExpression,
    ].includes(node.kind)
  ) {
    return false;
  }
  return node.forEachChild((child) => (quietCreation(child) ? undefined : true)) !== true;
}

/** Unproven coercion operands can execute application hooks before a later conversion. */
export function conversionRunsCode(node: Node): boolean {
  if (
    isPrefixUnaryExpression(node) &&
    [SyntaxKind.MinusToken, SyntaxKind.PlusToken, SyntaxKind.TildeToken].includes(node.operator)
  ) {
    return primitiveOf(node.operand, undefined) === undefined;
  }
  if (isBinaryExpression(node) && CONVERTING.has(node.operatorToken.kind)) {
    return (
      primitiveOf(node.left, undefined) === undefined ||
      primitiveOf(node.right, undefined) === undefined
    );
  }
  return (
    isTemplateExpression(node) &&
    node.templateSpans.some((span) => primitiveOf(span.expression, undefined) === undefined)
  );
}

/** Prior application evaluation can supply an inherited exotic hook or replace ordinary defaults. */
function earlierApplication(node: Node): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (
      isBlock(each.parent) &&
      each.parent.statements.some((statement) => {
        return (
          statement.end <= each.pos &&
          !isFunctionDeclaration(statement) &&
          !quietCreation(statement)
        );
      })
    ) {
      return true;
    }
    if (runsLater(each.parent) || isFunctionDeclaration(each.parent)) {
      break;
    }
  }
  return false;
}
