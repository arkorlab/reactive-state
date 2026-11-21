import {
  type BindingElement,
  type BindingName,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTemplateExpression,
  isTypeOfExpression,
  isVariableStatement,
  type ObjectLiteralElementLike,
  type PropertyAccessExpression,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { mayMakeCollection } from './collection-values.ts';
import type { Fail } from './errors.ts';
import type { ContextParameter } from './middleware-reads.ts';
import { mutatedCollection, mutatedSharedConstant } from './middleware-shared-writes.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * Whether a route middleware's constant of the params alone is computed alike wherever it is
 * written: one both the guard — which the authority runs — and the envelope — which the host runs
 * around each request — read is written into each, and computed by each, once for each, where the
 * middleware computes it once. It is the same value in both only where it is made of literals, the
 * context's params, and constants made so: no call, no global and no import, each of which a side
 * computes or reads as its own.
 */

/** The kinds of a literal: a value written as it is. */
const LITERALS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TrueKeyword,
]);

/** What a constant computed alike may read: names of the params and of constants so, and the context. */
interface Alike {
  /** The names the params are bound to, and each constant computed alike so far. */
  readonly names: Set<string>;
  /** The context, bound whole: read alike by its `params` alone. */
  readonly context: string | undefined;
}

/** What a middleware of `context` starts reading alike: the names its params are bound to. */
function alikeOf(context: ContextParameter | undefined): Alike {
  if (context?.kind !== 'pattern') {
    return { context: context?.name.text, names: new Set() };
  }
  const names = [...context.properties].flatMap(([name, property]) =>
    property === 'params' ? [name] : [],
  );
  return { context: undefined, names: new Set(names) };
}

/** Whether `access` is the context's params, read off the context bound whole: `context.params`. */
function isContextParams(access: PropertyAccessExpression, alike: Alike): boolean {
  return (
    alike.context !== undefined &&
    isIdentifier(access.expression) &&
    access.expression.text === alike.context &&
    access.name.text === 'params'
  );
}

/** Whether `value`, an operation, is one of operands computed alike: no assignment among them. */
function isAlikeOperation(value: Expression, alike: Alike): boolean {
  if (isBinaryExpression(value)) {
    const operator = value.operatorToken.kind;
    const assigns = operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment;
    return !assigns && isAlike(value.left, alike) && isAlike(value.right, alike);
  }
  if (isPrefixUnaryExpression(value)) {
    const counts =
      value.operator === SyntaxKind.PlusPlusToken || value.operator === SyntaxKind.MinusMinusToken;
    return !counts && isAlike(value.operand, alike);
  }
  if (isTypeOfExpression(value)) {
    return isAlike(value.expression, alike);
  }
  return (
    isConditionalExpression(value) &&
    [value.condition, value.whenTrue, value.whenFalse].every((each) => isAlike(each, alike))
  );
}

/** Whether a member of an object literal holds a value computed alike, under a key so. */
function isAlikeMember(member: ObjectLiteralElementLike, alike: Alike): boolean {
  if (isShorthandPropertyAssignment(member)) {
    return (
      member.objectAssignmentInitializer === undefined &&
      isIdentifier(member.name) &&
      alike.names.has(member.name.text)
    );
  }
  if (isSpreadAssignment(member)) {
    return isAlike(member.expression, alike);
  }
  return (
    isPropertyAssignment(member) &&
    (!isComputedPropertyName(member.name) || isAlike(member.name.expression, alike)) &&
    isAlike(member.initializer, alike)
  );
}

/** Whether `value`, an object or an array written out, holds values computed alike alone. */
function isAlikeCollection(value: Expression, alike: Alike): boolean {
  if (isArrayLiteralExpression(value)) {
    return value.elements.every((element) => {
      return (
        isOmittedExpression(element) ||
        isAlike(isSpreadElement(element) ? element.expression : element, alike)
      );
    });
  }
  return (
    isObjectLiteralExpression(value) &&
    value.properties.every((member) => isAlikeMember(member, alike))
  );
}

/** Whether `node` is computed alike wherever it is written. */
function isAlike(node: Expression, alike: Alike): boolean {
  const value = unwrapped(node);
  if (LITERALS.has(value.kind)) {
    return true;
  }
  if (isIdentifier(value)) {
    return value.text === 'undefined' || alike.names.has(value.text);
  }
  if (isPropertyAccessExpression(value)) {
    return isContextParams(value, alike) || isAlike(value.expression, alike);
  }
  if (isElementAccessExpression(value)) {
    return isAlike(value.expression, alike) && isAlike(value.argumentExpression, alike);
  }
  if (isTemplateExpression(value)) {
    return value.templateSpans.every((span) => isAlike(span.expression, alike));
  }
  return isAlikeOperation(value, alike) || isAlikeCollection(value, alike);
}

/**
 * Whether a binding — its defaults and its computed keys among it — reads alike alone, read in the
 * order the language binds it: each name it binds is added to `alike` once it is read so, for what
 * follows it to read (`[first, second = first]`).
 */
function bindsAlike(name: BindingName, alike: Alike): boolean {
  if (isIdentifier(name)) {
    alike.names.add(name.text);
    return true;
  }
  return name.elements.every((element) => {
    if (isOmittedExpression(element)) {
      return true;
    }
    const key = element.propertyName;
    const inner: BindingName | undefined = element.name;
    return (
      (key === undefined || !isComputedPropertyName(key) || isAlike(key.expression, alike)) &&
      (element.initializer === undefined || isAlike(element.initializer, alike)) &&
      (inner === undefined || bindsAlike(inner, alike))
    );
  });
}

/**
 * Whether `statement`, a `const` of the params alone, is computed alike wherever it is written: its
 * declarations in their order, each read with the names those before it bind
 * (`const key = params.id, tag = key + '-board'`) — of a copy of `alike`'s, which the statement's
 * names join only once all of it is read so.
 */
function isComputedAlike(statement: Statement, alike: Alike): boolean {
  if (!isVariableStatement(statement)) {
    return false;
  }
  const within: Alike = { context: alike.context, names: new Set(alike.names) };
  return statement.declarationList.declarations.every((declaration) => {
    return (
      declaration.initializer !== undefined &&
      isAlike(declaration.initializer, within) &&
      bindsAlike(declaration.name, within)
    );
  });
}

/** A constant of the params alone, as the split reads one: its statement, and what it declares. */
export interface ParamsConstant {
  readonly statement: Statement;
  readonly declares: readonly string[];
}

/** Why a constant both parts read, computed so by each, is refused. */
function computedTwice(names: readonly string[]): string {
  const named = names.map((name) => `\`${name}\``).join(', ');
  return `${named}, read by the guard — which the authority runs — and by what the host runs around each request, before \`next\` or after it, would be computed by each of them, a value of each's own, where the middleware computes it once: only a constant of literals and the params alone is written into both. Read it on one side alone — what the guard reads in the guard, what is of the request where the host runs it — or compute it of literals and the params alone.`;
}

/**
 * Refuses each of `constants` — the middleware's constants of the params alone, in order — that
 * both the guard and the envelope read (`readByBoth`) where it is not computed alike: written into
 * each, it would be computed by each, once for each.
 */
export function checkComputedOnce<T extends ParamsConstant>(
  constants: readonly T[],
  readBy: { readonly both: (constant: T) => boolean; readonly host?: (name: string) => boolean },
  context: ContextParameter | undefined,
  fail: Fail,
): void {
  if (readBy.host !== undefined) {
    const mutated = mutatedSharedConstant(constants, readBy.both, readBy.host);
    if (mutated !== undefined) {
      const named = mutated.declares.map((name) => `\`${name}\``).join(', ');
      fail(
        `A collection (${named}) read by both the guard and the host is mutated or passed to a call that may mutate it: each part would hold its own copy, so a write by one would be absent from the other. Keep the collection on one side, or copy its primitive value before the guard.`,
        mutated.statement,
      );
    }
  }
  const alike = alikeOf(context);
  for (const constant of constants) {
    if (isComputedAlike(constant.statement, alike)) {
      for (const name of constant.declares) {
        alike.names.add(name);
      }
    } else if (readBy.both(constant)) {
      fail(computedTwice(constant.declares), constant.statement);
    }
  }
}

/** Why a default of the context's pattern both parts bind is refused. */
function boundTwice(names: readonly string[]): string {
  const named = names.map((name) => `\`${name}\``).join(', ');
  return `${named}, read by the guard — which the authority runs — and by what the host runs around each request, before \`next\` or after it, would be bound by each of them, the default each holds computed by each, a value of each's own, where the middleware computes it once: only a default of literals and the params alone is written into both. Read it on one side alone, or give it a default of literals and the params alone.`;
}

/** Which part of a middleware reads a name of its context: the guard, and what the host runs. */
interface ContextReaders {
  readonly guard: (name: string) => boolean;
  readonly host: (name: string) => boolean;
}

/** What a check of the context's pattern is handed: what it reads alike so far, and of what. */
interface Binding {
  readonly alike: Alike;
  /** Whether the element is of the context's `params`, whose names it reads alike once bound. */
  readonly params: boolean;
  /** Whether a pattern the element is within has a default of an object or an array written there. */
  readonly collected: boolean;
  /** Whether the element binds an object the context hands, its own prop: `params`, `request`. */
  readonly handed: boolean;
  readonly readBy: ContextReaders;
  readonly fail: Fail;
}

/** Why an object the context hands, which both parts bind, is refused where it is written. */
function handedTwice(name: string): string {
  return `\`${name}\`, an object the context hands both the guard — which the authority runs — and what the host runs around each request, is written by the middleware, or handed to a call that may write it: each part is handed one of its own, so a write by one is absent from the other. Read it on one side alone, or copy its primitive value before the guard.`;
}

/** Why a collection a default of the context's pattern gives, which both parts bind, is refused where it is written. */
function writtenTwice(name: string): string {
  return `A default of the context's pattern, \`${name}\`, read by the guard — which the authority runs — and by what the host runs around each request, holds an object or an array the middleware writes, or hands to a call that may write it: each part binds a copy of its own, so a write by one is absent from the other. Read it on one side alone, or copy its primitive value before the guard.`;
}

/** Whether `node`, a default, may make an object or an array there, whose identity each part makes anew. */
function collection(node: Expression | undefined): boolean {
  return node !== undefined && mayMakeCollection(node);
}

/**
 * Refuses the default of `element`, and the key it computes, where either is not computed alike and
 * both parts bind it — each reads a name it binds, the same or another; then each element within
 * it, in the order the language binds them — a name of the params read alike by what follows once
 * it is bound so.
 */
function checkBound(element: BindingElement, binding: Binding): void {
  const { name, propertyName: key } = element;
  if (name === undefined) {
    return;
  }
  const bound = bindingIdentifiers(name).map((identifier) => identifier.text);
  const shared =
    bound.some((each) => binding.readBy.guard(each)) &&
    bound.some((each) => binding.readBy.host(each));
  const computed = key !== undefined && isComputedPropertyName(key) ? key.expression : undefined;
  for (const value of [computed, element.initializer]) {
    if (value !== undefined && shared && !isAlike(value, binding.alike)) {
      binding.fail(boundTwice(bound), value);
    }
  }
  if (isIdentifier(name)) {
    // Where both parts bind it, each holds an object of its own: a write by one is lost.
    bindName(name, shared ? writtenReason(name, element, binding) : undefined, binding);
    return;
  }
  const within = {
    ...binding,
    collected: binding.collected || collection(element.initializer),
    handed: false,
  };
  for (const inner of name.elements) {
    if (!isOmittedExpression(inner)) {
      checkBound(inner, within);
    }
  }
}

/**
 * Why `name`, which both parts bind, is refused: where it holds an object the context hands, or a
 * collection a default gives, that the middleware writes or hands to a call that may write it.
 */
function writtenReason(
  name: Identifier,
  element: BindingElement,
  binding: Binding,
): string | undefined {
  const held = binding.handed || binding.collected || collection(element.initializer);
  if (!held || !mutatedCollection(name, element.initializer)) return undefined;
  return binding.handed ? handedTwice(name.text) : writtenTwice(name.text);
}

/**
 * Binds `name`, refused for `reason` where one is given; a name of the params is read alike by
 * what follows once it is bound.
 */
function bindName(name: Identifier, reason: string | undefined, binding: Binding): void {
  if (reason !== undefined) {
    binding.fail(reason, name);
  }
  if (binding.params) {
    binding.alike.names.add(name.text);
  }
}

/**
 * Refuses each default of the context's pattern — `({ params: { tenant = crypto.randomUUID() } },
 * next)`, `{ absent: { guardNonce, headerNonce } = makeNoncePair() }` — and each key it computes,
 * that is not computed alike where both the guard and the envelope bind it: where each reads a name
 * it binds (`readBy`), the same or another. The pattern is written into each part that reads its
 * names, and each would compute the default, once for each, where the middleware computes it once.
 */
export function checkContextDefaults(
  context: ContextParameter | undefined,
  readBy: ContextReaders,
  fail: Fail,
): void {
  if (context?.kind === 'whole') {
    // The context bound whole, as each part is handed one of its own: a write by one is lost.
    const { name } = context;
    if (readBy.guard(name.text) && readBy.host(name.text) && mutatedCollection(name, undefined)) {
      fail(handedTwice(name.text), name);
    }
    return;
  }
  if (context?.kind !== 'pattern') {
    return;
  }
  const alike: Alike = { context: undefined, names: new Set() };
  for (const element of context.pattern.elements) {
    const key = element.propertyName ?? element.name;
    const params = key !== undefined && isIdentifier(key) && key.text === 'params';
    checkBound(element, { alike, collected: false, fail, handed: true, params, readBy });
  }
}
