import {
  type BinaryExpression,
  type BindingElement,
  type BindingPattern,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isBinaryExpression,
  isBindingElement,
  isComputedPropertyName,
  isConditionalExpression,
  isFunctionExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  isTypeOfExpression,
  type Node,
  type ObjectLiteralElementLike,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';
import type { ImportBinding } from './imports.ts';
import type { MiddlewareSplit } from './middleware.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * What of a route middleware's context pattern runs where its part before `next` binds it: the
 * defaults and computed keys `patternOf` (`emit-middleware.ts`) writes into `before`, which the
 * host runs ahead of a guard around the middleware (`middleware-order.ts`). A default of literals,
 * of a function, of an import or of a name bound before it — or an operation of literals other than
 * a BigInt's and of names the context gives a value of its own, text or the request, or that such
 * an operation defaults — cannot throw there, nor have an effect; anything else may: an operation
 * of a name a BigInt, an object, an import or a pattern's default may give, whose conversion may
 * throw or write. A pattern within the context's `params` and `request` takes its value apart, which
 * throws of none, or of what is not iterable: but of a param given a default written there.
 */

/** The literals an operation's operand may be: none of a BigInt's, which another number throws of. */
const OPERAND_LITERALS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TrueKeyword,
]);

/**
 * The supported binary operators retain separate value-evaluation and primitive-conversion
 * requirements: none of `in` or `instanceof`, nor an assignment.
 */
const QUIET_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.AmpersandToken,
  SyntaxKind.AsteriskAsteriskToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.BarToken,
  SyntaxKind.CaretToken,
  SyntaxKind.CommaToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
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
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.SlashToken,
]);

/** The primitives an object's pattern takes apart, written as a default: none of `null`. */
const GIVEN_PRIMITIVES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.TrueKeyword,
]);

/** The prefix operators that neither throw of such operands nor write: none of `++` or `--`. */
const QUIET_PREFIXES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ExclamationToken,
  SyntaxKind.MinusToken,
  SyntaxKind.PlusToken,
  SyntaxKind.TildeToken,
]);

/**
 * What a default may read and not throw: the names the pattern binds before it, those of them an
 * operation may read too (`operands`), and the imports — no parameter binds an import's name again
 * (`middlewareNames`, `middleware-reads.ts`, refuses a name declared twice) — but those of a type
 * alone, which bind nothing that runs.
 */
interface Scope {
  readonly bound: ReadonlySet<string>;
  readonly operands: ReadonlySet<string>;
  readonly objects: ReadonlySet<string>;
  readonly imports: ReadonlyMap<string, ImportBinding>;
}

/** What an element of the pattern is within. */
interface Within {
  /** Whether the part keeps it whole, as an array's pattern is kept. */
  readonly whole: boolean;
  /** Whether a pattern it is within has a default, which may give what it binds. */
  readonly defaulted: boolean;
  /** How deep it stands: 0 of the context's own props, 1 of what one of them holds. */
  readonly depth: number;
  /** Whether it is within the context's `params`, whose values are text or none. */
  readonly params: boolean;
}

/** An element of the pattern still to read, and what it is within. */
interface Pending extends Within {
  readonly element: BindingElement;
}

/** The context's props a part is handed, each an object: `params`, `request`. */
const CONTEXT_PROPS: ReadonlySet<string> = new Set(['params', 'request']);

/** What the context's pattern is within: nothing. */
const TOP: Within = { defaulted: false, depth: 0, params: false, whole: false };

/**
 * The first default, computed key or pattern of the context's pattern that the part before `next`
 * binds, read in the order the language binds them, which may throw or have an effect; none where
 * the part binds none, or binds the context whole.
 */
export function boundBeforeNext(split: MiddlewareSplit): Node | undefined {
  const { before, names } = split;
  const { context, imports } = names;
  if (before === undefined || context?.kind !== 'pattern' || before.context.length === 0)
    return undefined;
  const kept = new Set(before.context);
  const scope = {
    bound: new Set<string>(),
    imports,
    objects: new Set<string>(),
    operands: new Set<string>(),
  };
  const pending = elementsOf(context.pattern.elements, TOP);
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const { name } = at.element;
    if (
      name === undefined ||
      !(at.whole || bindingIdentifiers(name).some((each) => kept.has(each.text)))
    )
      continue;
    const ran = unquietRun(at.element, scope) ?? (unsafePattern(at) ? name : undefined);
    if (ran !== undefined) return ran;
    if (isIdentifier(name)) bind(name.text, at, scope);
    else pending.push(...elementsOf(name.elements, within(at, name)));
  }
  return undefined;
}

/** What the elements of `name`, the pattern `at` binds, are within. */
function within(at: Pending, name: BindingPattern): Within {
  return {
    defaulted: at.defaulted || at.element.initializer !== undefined,
    depth: at.depth + 1,
    params: at.depth === 0 ? keyOf(at.element) === 'params' : at.params,
    whole: at.whole || !isObjectBindingPattern(name),
  };
}

/** The key `element` takes its value by, where the code writes it as a name. */
function keyOf(element: BindingElement): string | undefined {
  const key = element.propertyName ?? element.name;
  return key !== undefined && isIdentifier(key) ? key.text : undefined;
}

/**
 * Whether the pattern `at` binds may throw as it takes its value apart — an object's of what may be
 * undefined or null, an array's of what may not be iterable: all but one of the context's `params`
 * or `request`, objects, and one of a param given a default written there of the pattern's kind.
 */
function unsafePattern(at: Pending): boolean {
  const { depth, element, params } = at;
  const { name } = element;
  if (name === undefined || isIdentifier(name)) return false;
  const object = isObjectBindingPattern(name);
  if (depth === 0) return !object || !CONTEXT_PROPS.has(keyOf(element) ?? '');
  return depth > 1 || !params || !given(element.initializer, object);
}

/**
 * Whether `node`, a default, is a value written there that a pattern takes apart: of an object's,
 * any — an object only of its own data, whose prototype no `__proto__` member sets, which an
 * object's pattern would read what it does not hold of: a getter of the request's, of an import.
 */
function given(node: Expression | undefined, object: boolean): boolean {
  if (node === undefined) return false;
  const value = unwrapped(node);
  if (
    isArrayLiteralExpression(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value)
  )
    return true;
  if (isObjectLiteralExpression(value))
    return object && value.properties.every((property) => !setsPrototype(property));
  return object && GIVEN_PRIMITIVES.has(value.kind);
}

/** Whether `property` is an object's `__proto__` member, written or as text, which sets its prototype. */
function setsPrototype(property: ObjectLiteralElementLike): boolean {
  if (isSpreadAssignment(property)) return false;
  const { name } = property;
  return (
    (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) &&
    name.text === '__proto__'
  );
}

/**
 * Binds `name` of `at`: one an operation may read too where what gives it its value is the context
 * — text, the request — or an operation such a default is (`quietOperand`).
 */
function bind(
  name: string,
  at: Pending,
  scope: {
    readonly bound: Set<string>;
    readonly operands: Set<string>;
    readonly objects: Set<string>;
    readonly imports: ReadonlyMap<string, ImportBinding>;
  },
): void {
  const { initializer } = at.element;
  const wholeParams = at.depth === 0 && keyOf(at.element) === 'params';
  if (wholeParams) scope.objects.add(name);
  if (
    !wholeParams &&
    !at.defaulted &&
    (initializer === undefined || quietOperand(initializer, scope))
  )
    scope.operands.add(name);
  scope.bound.add(name);
}

/** The elements still to read, the first last: what a pattern binds, in its order. */
function elementsOf(elements: readonly Node[], place: Within): Pending[] {
  const found: Pending[] = [];
  for (const element of elements.toReversed()) {
    if (isBindingElement(element)) found.push({ element, ...place });
  }
  return found;
}

/**
 * The first of what binding `element` runs that may throw or have an effect: the key it computes,
 * which is made a key as an operation's operand is made a primitive (`quietOperand`) — of an
 * import, an object, a function, by a conversion that may throw or write — then its default.
 */
function unquietRun(element: BindingElement, scope: Scope): Expression | undefined {
  const { initializer, propertyName } = element;
  const key =
    propertyName !== undefined && isComputedPropertyName(propertyName)
      ? propertyName.expression
      : undefined;
  if (key !== undefined && !quietOperand(key, scope)) return key;
  if (initializer === undefined || quiet(initializer, scope)) return undefined;
  return initializer;
}

/** Whether `node` neither throws nor has an effect where it is bound: what this module's header says. */
function quiet(node: Expression, scope: Scope): boolean {
  return quietInput(node, scope, false);
}

/**
 * A function, an import of a value, a name bound before it, a BigInt written, or negated: values
 * read whole, of no operation.
 */
function quietAtom(value: Expression, scope: Scope): boolean {
  if (isArrowFunction(value) || isFunctionExpression(value) || isBigIntLiteral(value)) return true;
  if (isIdentifier(value))
    return scope.imports.get(value.text)?.typeOnly === false || scope.bound.has(value.text);
  return (
    isPrefixUnaryExpression(value) &&
    value.operator === SyntaxKind.MinusToken &&
    isBigIntLiteral(unwrapped(value.operand))
  );
}

/** The values an array or an object written of them holds: none of a spread, a computed key or a method. */
function partsOf(value: Expression): readonly Expression[] | undefined {
  if (isArrayLiteralExpression(value)) {
    if (value.elements.some((element) => isSpreadElement(element))) return undefined;
    return value.elements.filter((element) => !isOmittedExpression(element));
  }
  if (!isObjectLiteralExpression(value)) return undefined;
  const parts: Expression[] = [];
  for (const property of value.properties) {
    const part = partOf(property);
    if (part === undefined) return undefined;
    parts.push(part);
  }
  return parts;
}

/** The value an object's member written as data holds: a name's, or what a written key holds. */
function partOf(property: ObjectLiteralElementLike): Expression | undefined {
  if (isShorthandPropertyAssignment(property))
    return isIdentifier(property.name) ? property.name : undefined;
  return isPropertyAssignment(property) && !isComputedPropertyName(property.name)
    ? property.initializer
    : undefined;
}

/**
 * Whether `node` is made of literals other than a BigInt's and of `operands` alone — names an
 * operation may read without a conversion that throws or writes — and the global `undefined`, where
 * nothing in the file binds that name (`globalOf`), as the pattern may: `{ undefined = 1n }`.
 */
function quietOperand(node: Expression, scope: Scope): boolean {
  return quietInput(node, scope, true);
}

interface Operand {
  readonly value: Expression;
  readonly primitive: boolean;
}

/** Strict comparisons inspect values without invoking their primitive-conversion hooks. */
const STRICT_COMPARISONS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
]);

/** Logical results retain their selected operand rather than converting it to a primitive. */
const VALUE_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** A quiet value may remain an object; only its consuming operations require quiet coercion. */
function quietInput(node: Expression, scope: Scope, primitive: boolean): boolean {
  const pending: Operand[] = [{ value: node, primitive }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next.value);
    if (
      OPERAND_LITERALS.has(value.kind) ||
      (isIdentifier(value) && (scope.operands.has(value.text) || globalOf(value) === 'undefined'))
    )
      continue;
    if (!next.primitive && quietAtom(value, scope)) continue;
    const parts = next.primitive ? undefined : partsOf(value);
    const inputs =
      parts === undefined
        ? operationInputs(value, next.primitive, scope)
        : parts.map((part) => ({ value: part, primitive: false }));
    if (inputs === undefined) return false;
    pending.push(...inputs);
  }
  return true;
}

/** Each supported operation keeps the native conversion mode of its evaluated inputs. */
function operationInputs(
  value: Expression,
  primitive: boolean,
  scope: Scope,
): readonly Operand[] | undefined {
  if (isBinaryExpression(value)) {
    if (!QUIET_OPERATORS.has(value.operatorToken.kind)) return undefined;
    return binaryInputs(value, primitive, scope);
  }
  if (isPrefixUnaryExpression(value))
    return QUIET_PREFIXES.has(value.operator)
      ? [{ value: value.operand, primitive: value.operator !== SyntaxKind.ExclamationToken }]
      : undefined;
  if (isTypeOfExpression(value)) return [{ value: value.expression, primitive: false }];
  if (isConditionalExpression(value))
    return [
      { value: value.condition, primitive: false },
      { value: value.whenTrue, primitive },
      { value: value.whenFalse, primitive },
    ];
  return isTemplateExpression(value)
    ? value.templateSpans.map((span) => ({ value: span.expression, primitive: true }))
    : undefined;
}

/** A comma discards its first value; logical results keep alternatives, comparisons do not. */
function binaryInputs(
  value: BinaryExpression,
  primitive: boolean,
  scope: Scope,
): readonly Operand[] {
  const { left, right, operatorToken } = value;
  const operator = operatorToken.kind;
  if (operator === SyntaxKind.CommaToken)
    return [
      { value: left, primitive: false },
      { value: right, primitive },
    ];
  const first = unwrapped(left);
  if (
    operator === SyntaxKind.AmpersandAmpersandToken &&
    isIdentifier(first) &&
    scope.objects.has(first.text)
  )
    return [
      { value: left, primitive: false },
      { value: right, primitive },
    ];
  let converts = true;
  if (STRICT_COMPARISONS.has(operator)) converts = false;
  else if (VALUE_OPERATORS.has(operator)) converts = primitive;
  return [
    { value: left, primitive: converts },
    { value: right, primitive: converts },
  ];
}
