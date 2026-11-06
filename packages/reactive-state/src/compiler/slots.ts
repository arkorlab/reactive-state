import {
  type Expression,
  type Identifier,
  isArrowFunction,
  isBinaryExpression,
  isConditionalExpression,
  isFunctionExpression,
  isIdentifier,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxSelfClosingElement,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  type JsxElement,
  type JsxSelfClosingElement,
  type Node,
  type ReturnStatement,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';
import type { Fail } from './errors.ts';
import { constantNumber } from './numbers.ts';

/**
 * The reactive components a component with state renders in its JSX — `<TodoCommands …/>` among
 * the browser's elements — and the nodes it is given (`{children}`), which the authority renders:
 * each is hoisted into a slot of the client part, which the authority's program renders with the
 * server part's values and the Client Component shows where it stood (`slotOf(part, "s0")`). What is
 * hoisted is the largest expression around it that reads none of the browser's values — the
 * element, or the JSX expression it is in, condition and all — and whatever still decides in the
 * browser whether it shows reads none either: the authority renders a slot whatever the browser
 * holds. A reactive component no slot can hold — its props read a local state, or a condition of the
 * browser's stands over it — is rendered at a dynamic site instead (`sites.ts`); a node no slot can
 * hold is refused.
 */

export interface Slot {
  /** `s0`, `s1`…, in the order the slots stand in the JSX. */
  readonly name: string;
  /** What the authority renders into it. */
  readonly unit: Expression;
  /** Whether it stands as a child of JSX, which the Client Component writes in braces. */
  readonly child: boolean;
}

/** An element that renders a reactive component. */
export type ReactiveElement = JsxElement | JsxSelfClosingElement;

/** The key an element is given: `key={…}`, or `key="…"`. */
export function keyOf(element: ReactiveElement): Expression | undefined {
  const { properties } = (isJsxElement(element) ? element.openingElement : element).attributes;
  for (const attribute of properties) {
    if (
      isJsxAttribute(attribute) &&
      isIdentifier(attribute.name) &&
      attribute.name.text === 'key'
    ) {
      const { initializer } = attribute;
      return initializer !== undefined && isJsxExpression(initializer)
        ? initializer.expression
        : initializer;
    }
  }
  return undefined;
}

/** The operators a list may stand right of, under a condition: `&&`, `||`, `??`. */
const LIST_RIGHT_OF: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * What uses the keyed `.map()` `call` otherwise than as it is — `.slice(…)`, `.filter(…)` after it,
 * a spread of it — where the authority, rendering an item for each of the array the `.map()` is of,
 * would render the items the browser leaves out; none where it stands as it is, within parentheses
 * and the conditions it shows under, in braces of the JSX.
 */
export function listMisuseOf(call: Expression): Node | undefined {
  let child: Node = call;
  for (let node: Node = call.parent; ; child = node, node = node.parent) {
    if (isJsxExpression(node)) {
      return undefined;
    }
    const held =
      isParenthesizedExpression(node) ||
      (isConditionalExpression(node) && node.condition !== child) ||
      (isBinaryExpression(node) &&
        LIST_RIGHT_OF.has(node.operatorToken.kind) &&
        node.right === child);
    if (!held) {
      return node;
    }
  }
}

/** The globals that hold what is never a key of a list's item, but a number's (`constantNumber`). */
const NOT_KEYS: ReadonlySet<string> = new Set(['undefined']);

/** Refuses the key of a list's item where the code shows it is neither text nor a finite number. */
export function checkKey(key: Expression, fail: Fail): void {
  const invalid = invalidKeyOf(key);
  if (invalid !== undefined) {
    fail(
      `The key of a list's item answers \`${invalid.getText()}\` here, which is neither text nor a finite number, and the authority refuses each item of a key but those — the list would never show: key the item by text, or a finite number, an id of its own.`,
      invalid,
    );
  }
}

/** What is never a key of a list's item, of its own kind of node: `true`, `null`, `{}`, `[]`. */
const INVALID_KEYS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.ClassExpression,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FunctionExpression,
  SyntaxKind.NullKeyword,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.TrueKeyword,
  SyntaxKind.VoidExpression,
]);

/** The operators that answer a boolean: comparisons, `in`, `instanceof`. */
const COMPARISONS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.LessThanToken,
]);

/**
 * What a list's `key` answers where the code shows it is neither text nor a finite number — `true`,
 * `null`, `undefined`, `NaN`, `Infinity`, `1e999`, an object, an array, a function, a comparison,
 * an integer of `BigInt` — of which the authority refuses each item, so that the list would never
 * show; none where the code shows nothing of the kind, in either answer of `?:`, `&&`, `||`, `??`.
 */
function invalidKeyOf(key: Expression): Node | undefined {
  // `1 / 0`, `-Infinity`: a number the code computes of numbers alone, a key where it is finite.
  const number = constantNumber(key);
  if (number !== undefined) {
    return Number.isFinite(number) ? undefined : unwrapped(key);
  }
  let value = unwrapped(key);
  // `-Infinity`, `+NaN`: a number of what it is of.
  while (
    isPrefixUnaryExpression(value) &&
    (value.operator === SyntaxKind.MinusToken || value.operator === SyntaxKind.PlusToken)
  ) {
    value = unwrapped(value.operand);
  }
  if (isConditionalExpression(value)) {
    return invalidKeyOf(value.whenTrue) ?? invalidKeyOf(value.whenFalse);
  }
  if (isBinaryExpression(value) && LIST_RIGHT_OF.has(value.operatorToken.kind)) {
    return invalidKeyOf(value.left) ?? invalidKeyOf(value.right);
  }
  if (isIdentifier(value)) {
    return NOT_KEYS.has(globalOf(value) ?? '') ? value : undefined;
  }
  return INVALID_KEYS.has(value.kind) ||
    (isBinaryExpression(value) && COMPARISONS.has(value.operatorToken.kind)) ||
    (isPrefixUnaryExpression(value) && value.operator === SyntaxKind.ExclamationToken)
    ? value
    : undefined;
}

/** What an element's attributes are given in braces — its props, its key — as they are written. */
export function attributeValues(element: ReactiveElement): readonly Expression[] {
  const { properties } = (isJsxElement(element) ? element.openingElement : element).attributes;
  return properties.flatMap((attribute) => {
    const initializer = isJsxAttribute(attribute) ? attribute.initializer : undefined;
    return initializer !== undefined &&
      isJsxExpression(initializer) &&
      initializer.expression !== undefined
      ? [initializer.expression]
      : [];
  });
}

/** What the slots are found with. */
export interface Finding {
  /** Whether an element renders a reactive component. */
  readonly isReactive: (element: ReactiveElement) => boolean;
  /** Whether `node` reads one of the browser's values: a state, a setter, a constant. */
  readonly readsBrowser: (node: Node) => boolean;
  /** Each read, in the JSX, of a prop that holds nodes (`children`). */
  readonly nodes: readonly Identifier[];
}

/** The slots of the browser's JSX, and the reactive elements no slot holds. */
export interface Found {
  readonly slots: readonly Slot[];
  /** The elements the authority renders at a dynamic site, in the order they stand in the JSX. */
  readonly sites: readonly ReactiveElement[];
}

export function findSlots(returned: ReturnStatement, finding: Finding, fail: Fail): Found {
  const root = returned.expression;
  if (root === undefined) {
    return { sites: [], slots: [] };
  }
  const elements: ReactiveElement[] = [];
  const visit = (node: Node): void => {
    if ((isJsxElement(node) || isJsxSelfClosingElement(node)) && finding.isReactive(node)) {
      elements.push(node);
      return;
    }
    node.forEachChild(visit);
  };
  visit(root);
  const seeds = [...elements, ...finding.nodes].toSorted((a, b) => a.pos - b.pos);
  const slots: Slot[] = [];
  const sites: ReactiveElement[] = [];
  for (const seed of seeds) {
    // What a slot holds is the slot's; a read of a node within a site's element is the site's to
    // refuse, which the authority renders again on its own.
    if (
      slots.some((slot) => contains(slot.unit, seed)) ||
      sites.some((site) => contains(site, seed))
    ) {
      continue;
    }
    if (isIdentifier(seed)) {
      slots.push({ ...nodeUnitOf(seed, returned, finding, fail), name: '' });
      continue;
    }
    const unit = unitOf(seed, returned, finding);
    if (unit === undefined) {
      sites.push(seed);
    } else {
      slots.push({ ...unit, name: '' });
    }
  }
  return {
    sites,
    slots: slots
      .toSorted((a, b) => a.unit.pos - b.unit.pos)
      .map((slot, index) => ({ ...slot, name: `s${String(index)}` })),
  };
}

function contains(outer: Node, inner: Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end;
}

/** What could be hoisted into a slot: an expression, and whether it stands as a child of JSX. */
type Unit = Omit<Slot, 'name'>;

/**
 * The slot `element` is hoisted into: the largest expression around it that reads none of the
 * browser's values, where no condition of the browser's stands over it. None where there is none.
 */
function unitOf(
  element: ReactiveElement,
  returned: ReturnStatement,
  finding: Finding,
): Unit | undefined {
  const chosen = largestOf(element, returned, finding);
  if (chosen === undefined || conditionOf(chosen.unit, returned, finding) !== undefined) {
    return undefined;
  }
  return chosen;
}

/** The largest expression around `seed` that reads none of the browser's values, if one does. */
function largestOf(
  seed: Identifier | ReactiveElement,
  returned: ReturnStatement,
  finding: Finding,
): Unit | undefined {
  const candidates: Unit[] = [
    { child: isJsxElement(seed.parent) || isJsxFragment(seed.parent), unit: seed },
  ];
  for (let node: Node = seed.parent; node !== returned; node = node.parent) {
    // Within a function, an expression runs as often as the function is called — once for each
    // item a `map` renders — where a slot is rendered once: only what holds the function whole can
    // be one.
    if (isFunction(node)) {
      candidates.length = 0;
    }
    if (isJsxExpression(node) && node.expression !== undefined) {
      candidates.push({ child: false, unit: node.expression });
    }
  }
  if (returned.expression !== undefined) {
    candidates.push({ child: false, unit: withoutParentheses(returned.expression) });
  }
  return candidates.findLast((candidate) => !finding.readsBrowser(candidate.unit));
}

/**
 * The slot a read of a node is hoisted into. Refused where none can hold it: the read is in a
 * function of the browser's — a `map`'s, a handler — or a condition of the browser's stands over it.
 */
function nodeUnitOf(
  read: Identifier,
  returned: ReturnStatement,
  finding: Finding,
  fail: Fail,
): Unit {
  const chosen = largestOf(read, returned, finding);
  if (chosen === undefined || isFunction(chosen.unit)) {
    return fail(
      `\`${read.text}\` holds nodes the authority renders, which the browser shows in a slot, rendered once, where they stand in the JSX the component returns — \`{${read.text}}\` — and not in a function of the browser's: a \`map\` calls one once for each item, a handler at an event. Show them outside the function, or give them to a \`'use client'\` component, which places them as it likes.`,
      read,
    );
  }
  const condition = conditionOf(chosen.unit, returned, finding);
  if (condition !== undefined) {
    return fail(
      `\`${read.text}\` holds nodes the authority renders into a slot whatever the browser holds, so whether they show does not depend on the browser's values: the condition they stand under reads a state, a setter or a constant of the browser's. Show them, and give them to a \`'use client'\` component that hides them — as a disclosure does — or decide the condition on the server.`,
      condition,
    );
  }
  return chosen;
}

/**
 * The first condition `unit` stands under that the browser would decide, reading the browser's
 * values: the test of a `?:`, the left of `&&`, `||` and `??`. None where none does.
 */
function conditionOf(unit: Node, returned: ReturnStatement, finding: Finding): Node | undefined {
  let child: Node = unit;
  for (let node: Node = unit.parent; node !== returned; node = node.parent) {
    const condition = testOf(node, child);
    if (condition !== undefined && finding.readsBrowser(condition)) {
      return condition;
    }
    child = node;
  }
  return undefined;
}

const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** The condition `node` decides whether its operand `child` renders by, if it does. */
function testOf(node: Node, child: Node): Node | undefined {
  if (isConditionalExpression(node) && child !== node.condition) {
    return node.condition;
  }
  if (isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind) && child === node.right) {
    return node.left;
  }
  return undefined;
}

/** Whether `node` is a function written in the JSX: an arrow, or a function expression. */
function isFunction(node: Node): boolean {
  return isArrowFunction(node) || isFunctionExpression(node);
}

function withoutParentheses(expression: Expression): Expression {
  let node = expression;
  while (isParenthesizedExpression(node)) {
    node = node.expression;
  }
  return node;
}
