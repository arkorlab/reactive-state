import {
  type BinaryExpression,
  type ElementAccessExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassExpression,
  isConditionalExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isRegularExpressionLiteral,
  isStringLiteral,
  isTemplateExpression,
  isTypeOfExpression,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { globalPathOf, patternKey } from './code-globals.ts';
import {
  arraySlotEntryKind,
  containerDynamicEntryKind,
  containerMemberEntryKind,
  identifierEntryKind,
  isGuaranteedUndefined,
  mutableSpreadReachesFunction,
} from './function-binding-entries.ts';
import { elementEntryKey } from './function-entry-writes.ts';
import {
  combineBranchKinds,
  type EntryKind,
  type FunctionKind,
  type ScanContext,
  withBranch,
} from './function-table-entries.ts';

/**
 * What of a shared module's code reads what each side's bundle writes otherwise of a function of its
 * (`settled.ts`): its source, which a bundle's transforms and its minifier write anew, and its name,
 * which a minifier may shorten — `pick.toString()`, `String(pick)`, `pick.name`.
 */

/** The members of a function each side's bundle writes otherwise: its source, its name. */
const BUNDLED: ReadonlySet<string> = new Set(['name', 'toString']);

/** The operators that make text of a function beside them: `+`, `+=`. */
const ADDING: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.PlusEqualsToken, SyntaxKind.PlusToken]);

/** The operators that answer their left or their right operand: `||`, `??`. */
const EITHER_OPERAND: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** The operators that answer their right operand, or a falsy left one: `&&`, `,`, `=`. */
const RIGHT_OPERAND: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.CommaToken,
  SyntaxKind.EqualsToken,
]);

const EXPRESSION_ENTRY_KINDS = new WeakMap<Expression, EntryKind>();

/**
 * What of `node` reads what each side's bundle writes otherwise of a function the code shows it
 * writes (`functionKind`): its source — `toString` of it, `String(pick)`, a template, `pick + ''` —
 * or a `.name` that comes from a declaration, variable or named expression rather than a static
 * object entry key.
 */
export function functionRead(node: Node): string | undefined {
  const read = memberRead(node);
  if (read !== undefined) {
    if (!BUNDLED.has(read.name)) {
      return undefined;
    }
    const kind = functionKind(unwrapped(read.of), new Set());
    return kind === undefined || (kind === 'entry' && read.name === 'name')
      ? undefined
      : `reads \`${read.name}\` of a function, which each side's bundle writes otherwise`;
  }
  const written = textOf(node);
  return written === undefined || functionKind(unwrapped(written), new Set()) === undefined
    ? undefined
    : "writes a function as text, which each side's bundle writes otherwise";
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
    return node.templateSpans.find(
      (span) => functionKind(unwrapped(span.expression), new Set()) !== undefined,
    )?.expression;
  }
  if (!isBinaryExpression(node) || !ADDING.has(node.operatorToken.kind)) {
    return undefined;
  }
  return functionKind(unwrapped(node.left), new Set()) === undefined ? node.right : node.left;
}

/** Classifies `node` as an object-entry-named function, a minifiable function, or neither. */
function functionKind(node: Expression, seen: Set<Node>): FunctionKind | undefined {
  const kind = expressionEntryKind(node, {
    classifyExpression: expressionEntryKind,
    hitCycle: false,
    mutableSpreadReachesFunction,
    seen,
  });
  return kind === 'entry' || kind === 'renamed' ? kind : undefined;
}

/** Cycle-aware worker classifying `node` as `'entry'`, `'renamed'`, `'non-function'`, or `'unknown'`. */
function expressionEntryKind(node: Expression, context: ScanContext): EntryKind {
  if (isArrowFunction(node) || isFunctionExpression(node) || isClassExpression(node)) {
    return 'renamed';
  }
  if (isNonFunctionSyntax(node)) {
    return 'non-function';
  }
  if (isIdentifier(node)) {
    return identifierEntryKind(node, context);
  }
  const cached = EXPRESSION_ENTRY_KINDS.get(node);
  if (cached !== undefined) {
    return cached;
  }
  return withBranch(context, (branch) => {
    const kind = computeComplexExpressionEntryKind(node, branch);
    if (!branch.hitCycle) {
      EXPRESSION_ENTRY_KINDS.set(node, kind);
    }
    return kind;
  });
}

/** Classifies conditional and member/element access expressions inside `context`. */
function computeComplexExpressionEntryKind(node: Expression, context: ScanContext): EntryKind {
  if (isConditionalExpression(node)) {
    const left = withBranch(context, (branch) =>
      expressionEntryKind(unwrapped(node.whenTrue), branch),
    );
    const right = withBranch(context, (branch) =>
      expressionEntryKind(unwrapped(node.whenFalse), branch),
    );
    return combineBranchKinds(left, right);
  }
  if (isPropertyAccessExpression(node)) {
    return containerMemberEntryKind(unwrapped(node.expression), node.name.text, context);
  }
  if (isElementAccessExpression(node)) {
    return elementEntryKind(node, context);
  }
  return isBinaryExpression(node) ? operandEntryKind(node, context) : 'unknown';
}

/**
 * Classifies an operator that answers one of its operands: `a && b` answers `b` or something falsy,
 * which no function is; `a || b` and `a ?? b` answer either; `(a, b)` and `a = b` answer `b`.
 */
function operandEntryKind(node: BinaryExpression, context: ScanContext): EntryKind {
  const operator = node.operatorToken.kind;
  const right = withBranch(context, (branch) => expressionEntryKind(unwrapped(node.right), branch));
  if (EITHER_OPERAND.has(operator)) {
    const left = withBranch(context, (branch) => expressionEntryKind(unwrapped(node.left), branch));
    return combineBranchKinds(left, right);
  }
  return RIGHT_OPERAND.has(operator) ? right : 'unknown';
}

/** Classifies a bracket entry read on an object or array holder, with static or dynamic key. */
function elementEntryKind(node: ElementAccessExpression, context: ScanContext): EntryKind {
  const holder = unwrapped(node.expression);
  const key = elementEntryKey(node);
  if (key === undefined) {
    return containerDynamicEntryKind(holder, context);
  }
  const fromMember = containerMemberEntryKind(holder, key, context);
  if (fromMember !== 'unknown' || !/^\d+$/u.test(key)) {
    return fromMember;
  }
  return arraySlotEntryKind(holder, Number(key), context);
}

/** Whether `node` is a container literal, primitive/regex literal, primitive unary operator, or `undefined`. */
function isNonFunctionSyntax(node: Expression): boolean {
  return (
    isObjectLiteralExpression(node) ||
    isArrayLiteralExpression(node) ||
    isPrimitiveOrRegexLiteral(node) ||
    isPrimitiveOperatorExpression(node) ||
    isGuaranteedUndefined(node)
  );
}

/** Whether `node` is a primitive, template, or regular-expression literal. */
function isPrimitiveOrRegexLiteral(node: Expression): boolean {
  return (
    isStringLiteral(node) ||
    isNoSubstitutionTemplateLiteral(node) ||
    isTemplateExpression(node) ||
    isNumericLiteral(node) ||
    isBigIntLiteral(node) ||
    isRegularExpressionLiteral(node) ||
    node.kind === SyntaxKind.TrueKeyword ||
    node.kind === SyntaxKind.FalseKeyword ||
    node.kind === SyntaxKind.NullKeyword
  );
}

/** Whether `node` applies a unary operator whose runtime result is always a primitive. */
function isPrimitiveOperatorExpression(node: Expression): boolean {
  return (
    isVoidExpression(node) ||
    isTypeOfExpression(node) ||
    isDeleteExpression(node) ||
    isPrefixUnaryExpression(node) ||
    isPostfixUnaryExpression(node)
  );
}
