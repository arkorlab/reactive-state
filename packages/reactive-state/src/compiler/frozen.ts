import {
  type BinaryExpression,
  type BindingName,
  type Expression,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isLiteralExpression,
  isNoSubstitutionTemplateLiteral,
  isNonNullExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isTemplateExpression,
  isTypeOfExpression,
  isVariableStatement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import type { Component } from './analyze.ts';
import { globalOf, unwrapped } from './bounded.ts';
import { isConstant } from './statements.ts';

/**
 * What a component's server part holds that nothing a call changes, as `writes.ts` reads what it
 * writes to: its props, which the authority freezes, its constants of primitives and of parts of
 * the props (`frozenIn`), and its constants of the language's own arrays and text, whose methods
 * of the names arrays and text read by change nothing (`builtInIn`).
 */

/** The methods of arrays and of text that answer an array or text of their own. */
const ANSWERING_BUILT_IN: ReadonlySet<string> = new Set([
  'concat',
  'filter',
  'flat',
  'flatMap',
  'join',
  'map',
  'normalize',
  'padEnd',
  'padStart',
  'repeat',
  'replace',
  'replaceAll',
  'slice',
  'split',
  'substring',
  'toLowerCase',
  'toReversed',
  'toSorted',
  'toSpliced',
  'toString',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
  'with',
]);

/**
 * What the server part holds that nothing a call changes (`frozen`), and the names of its
 * constants of the language's own arrays and text (`builtIn`), whose methods are the language's.
 */
export interface Known {
  readonly frozen: ReadonlySet<string>;
  readonly builtIn: ReadonlySet<string>;
}

/** What `component`'s server part holds that nothing a call changes (`Known`). */
export function knownIn(component: Component): Known {
  const frozen = frozenIn(component);
  return { builtIn: builtInIn(component, frozen), frozen };
}

/** The name a chain of reads starts at — `x` of `x.a[0].b` — or none of anything else. */
function rootOf(node: Node): string | undefined {
  const base = baseOf(node);
  return isIdentifier(base) ? base.text : undefined;
}

/** What a chain of reads starts at: `x` of `x.a[0].b`, `(cond ? a : b)` of `(cond ? a : b).c`. */
export function baseOf(node: Node): Node {
  let each = node;
  while (
    isPropertyAccessExpression(each) ||
    isElementAccessExpression(each) ||
    isParenthesizedExpression(each) ||
    isNonNullExpression(each) ||
    isAsExpression(each) ||
    isSatisfiesExpression(each)
  ) {
    each = each.expression;
  }
  return each;
}

/** The language's functions that answer a primitive: `Number(…)`, `String(…)`, `parseInt(…)`. */
const PRIMITIVE_FUNCTIONS: ReadonlySet<string> = new Set([
  'Boolean',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'isFinite',
  'isNaN',
  'Number',
  'parseFloat',
  'parseInt',
  'String',
]);

/** The globals that hold a primitive. */
const PRIMITIVE_GLOBALS: ReadonlySet<string> = new Set(['Infinity', 'NaN', 'undefined']);

/**
 * The names of `component`'s server part that hold what nothing a call changes: its props, which
 * the authority freezes, and each constant of a primitive the code computes, or of a part of a prop
 * or of another such constant — destructured too, but where an element takes a default.
 */
function frozenIn(component: Component): ReadonlySet<string> {
  const frozen = new Set(component.props.map((prop) => prop.local.text));
  for (const statement of component.server) {
    if (!isVariableStatement(statement) || !isConstant(statement, component.sourceFile)) {
      continue;
    }
    for (const { initializer, name } of statement.declarationList.declarations) {
      if (initializer !== undefined && isFrozen(initializer, frozen)) {
        for (const bound of boundNames(name)) {
          frozen.add(bound);
        }
      }
    }
  }
  return frozen;
}

/** Whether `node` is what nothing changes: a primitive, or a part of what `frozen` names. */
function isFrozen(node: Expression, frozen: ReadonlySet<string>): boolean {
  const value = unwrapped(node);
  if (isIdentifier(value) && PRIMITIVE_GLOBALS.has(globalOf(value) ?? '')) {
    return true;
  }
  if (
    isIdentifier(value) ||
    isPropertyAccessExpression(value) ||
    isElementAccessExpression(value)
  ) {
    const root = rootOf(value);
    return root !== undefined && frozen.has(root);
  }
  if (isBinaryExpression(value)) {
    return operandsFrozen(value, frozen);
  }
  if (isConditionalExpression(value)) {
    return isFrozen(value.whenTrue, frozen) && isFrozen(value.whenFalse, frozen);
  }
  // The language's own, by its binding: `Number` imported of a module is that module's.
  if (isCallExpression(value)) {
    return PRIMITIVE_FUNCTIONS.has(globalOf(unwrapped(value.expression)) ?? '');
  }
  return (
    isLiteralExpression(value) ||
    isTemplateExpression(value) ||
    isPrefixUnaryExpression(value) ||
    isPostfixUnaryExpression(value) ||
    isTypeOfExpression(value) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword
  );
}

/**
 * The names of `component`'s server part's constants of the language's own arrays and text — of a
 * literal, a template, or what one of their methods answers of one (`isBuiltIn`) — in order.
 */
function builtInIn(component: Component, frozen: ReadonlySet<string>): ReadonlySet<string> {
  const builtIn = new Set<string>();
  for (const statement of component.server) {
    if (!isVariableStatement(statement) || !isConstant(statement, component.sourceFile)) {
      continue;
    }
    for (const { initializer, name } of statement.declarationList.declarations) {
      if (
        initializer !== undefined &&
        isIdentifier(name) &&
        isBuiltIn(initializer, { builtIn, frozen })
      ) {
        builtIn.add(name.text);
      }
    }
  }
  return builtIn;
}

/**
 * Whether `node` is the language's own array or text, whose methods of `READING_METHODS`' names
 * change nothing: a literal of one, a template, a constant of one (`known.builtIn`), what nothing a
 * call changes (`known.frozen`: the props, JSON, and primitives), or what a method of theirs that
 * answers one answers of one — `items.filter(…).map(…)`.
 */
export function isBuiltIn(node: Expression, known: Known): boolean {
  const value = unwrapped(node);
  if (
    isArrayLiteralExpression(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isTemplateExpression(value)
  ) {
    return true;
  }
  if (isIdentifier(value)) {
    return known.builtIn.has(value.text) || known.frozen.has(value.text);
  }
  if (!isCallExpression(value)) {
    return false;
  }
  const callee = unwrapped(value.expression);
  return (
    isPropertyAccessExpression(callee) &&
    ANSWERING_BUILT_IN.has(callee.name.text) &&
    isBuiltIn(callee.expression, known)
  );
}

/** The operators that answer one of their operands: `&&`, `||`, `??`. */
const ANSWERING_OPERAND: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * Whether a binary expression answers what nothing changes: of an operator that computes a
 * primitive, or of one that answers an operand — `??`, `||`, `&&` — where each operand is so.
 */
function operandsFrozen(node: BinaryExpression, frozen: ReadonlySet<string>): boolean {
  const operator = node.operatorToken.kind;
  if (
    operator === SyntaxKind.CommaToken ||
    (operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment)
  ) {
    return false;
  }
  return (
    !ANSWERING_OPERAND.has(operator) ||
    (isFrozen(node.left, frozen) && isFrozen(node.right, frozen))
  );
}

/**
 * The names a declaration binds of parts of its value, but those an element binds that takes a
 * default, and a rest element, which binds an object or an array of its own: `others` of
 * `const { a, ...others } = options`.
 */
function boundNames(name: BindingName): readonly string[] {
  if (isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) => {
    return isBindingElement(element) &&
      element.name !== undefined &&
      element.initializer === undefined &&
      element.dotDotDotToken === undefined
      ? boundNames(element.name)
      : [];
  });
}
