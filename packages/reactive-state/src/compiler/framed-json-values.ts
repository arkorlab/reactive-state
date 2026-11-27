import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isExpressionStatement,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type ObjectLiteralElementLike,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { argumentArrayReached } from './framed-array-selections.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { jsonConstantDeclaration } from './framed-json-keys.ts';
import {
  jsonIndependentResult,
  jsonLiteralReceiver,
  jsonWrittenPrototype,
} from './framed-json-prototypes.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedObjectSources } from './framed-object-members.ts';

/** Written JSON receiver replacements retain literal fields and direct synchronous toJSON results. */

type JsonMember = Expression | MethodDeclaration;
type JsonSelection = readonly JsonMember[] | null;

export interface JsonValueSource {
  readonly value: Expression;
  readonly aliases: ReadonlySet<FrameBinding>;
  readonly exposed: boolean;
}

/** Whole literal aliases retain their original lexical source while closed holders stay unexposed. */
export function jsonValueSource(expression: Expression): JsonValueSource {
  const aliases = new Set<FrameBinding>();
  let value = unwrapped(expression);
  while (isIdentifier(value)) {
    const declared = jsonConstantDeclaration(value);
    if (declared?.initializer === undefined || aliases.has(declared)) break;
    aliases.add(declared);
    value = unwrapped(declared.initializer);
  }
  return { value, aliases, exposed: argumentArrayReached(expression, aliases) };
}

/** A written callable toJSON runs once before selecting the current serialized value's members. */
export function jsonToJSON(
  expression: Expression,
  source: JsonValueSource,
  call: Node,
): readonly Expression[] | null | undefined {
  const own =
    previousOwnMember(expression, source, call, 'toJSON') ?? ownMember(source.value, 'toJSON');
  const receiver =
    own === undefined ? jsonLiteralReceiver(expression, source.value, call) : undefined;
  const hook = receiver === undefined ? undefined : inheritedToJSON(source.value, call);
  const inherited = hook !== undefined;
  const written = hook === undefined ? own : hook.written;
  if (written === undefined || written === null) return written;
  if (written.length === 0) return [expression];
  const returned: Expression[] = [];
  for (const fn of written) {
    const results = jsonHookResults(fn, { expression, inherited });
    if (results === undefined) return inherited ? undefined : null;
    returned.push(...results);
  }
  if (hook !== undefined && (!(hook.unchanged && receiver?.unchanged === true) || source.exposed))
    returned.push(expression);
  return returned;
}

interface JsonHookContext {
  readonly expression: Expression;
  readonly inherited: boolean;
}

/** Known noncallable fields retain the receiver; direct methods bind bare this to that receiver. */
function jsonHookResults(
  member: JsonMember,
  context: JsonHookContext,
): readonly Expression[] | undefined {
  if (nonCallableJsonMember(member)) return [context.expression];
  const results = directJsonResults(member);
  if (results === undefined) return undefined;
  const returned: Expression[] = [];
  for (const result of results) {
    if (result.kind === SyntaxKind.ThisKeyword && isMethodDeclaration(member)) {
      returned.push(context.expression);
      continue;
    }
    if (context.inherited && !jsonIndependentResult(result)) return undefined;
    returned.push(result);
  }
  return returned;
}

/**
 * Nearest source-written prototype declarations shadow their parent hooks, including noncallable
 * values; a prototype a prior use may change leaves the hook it held possible, not settled.
 */
function inheritedToJSON(
  expression: Expression,
  call: Node,
): { readonly written: readonly JsonMember[]; readonly unchanged: boolean } | undefined {
  let value = unwrapped(expression);
  let unchanged = true;
  const seen = new Set<Node>();
  while (isObjectLiteralExpression(value)) {
    const selected = jsonWrittenPrototype(value, call);
    if (selected === undefined || seen.has(selected.prototype)) return undefined;
    const { prototype } = selected;
    seen.add(prototype);
    unchanged &&= selected.unchanged;
    const own = ownMember(prototype, 'toJSON');
    if (own === null) return undefined;
    if (own !== undefined) return { written: own, unchanged };
    value = prototype;
  }
  return undefined;
}

/** An own primitive or literal-container toJSON value is read but is never called by JSON. */
function nonCallableJsonMember(member: JsonMember): boolean {
  if (isMethodDeclaration(member)) return false;
  const value = unwrapped(member);
  return (
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isNumericLiteral(value) ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    [SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword].includes(
      value.kind,
    ) ||
    globalPathOf(value)?.join('.') === 'undefined'
  );
}

/** An explicit own selected field replaces a native Error member before JSON descends into it. */
export function jsonOwnMember(
  expression: Expression,
  source: JsonValueSource,
  call: Node,
  name: string,
): readonly Expression[] | null | undefined {
  const own = previousOwnMember(expression, source, call, name) ?? ownMember(source.value, name);
  if (own === null || own === undefined) return own;
  return own.filter((each): each is Expression => !isMethodDeclaration(each));
}

/** Only direct returns establish callable results; arbitrary bodies retain the opaque boundary. */
function directJsonResults(method: JsonMember): readonly Expression[] | undefined {
  let value: Node = isMethodDeclaration(method) ? method : unwrapped(method);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const initial = jsonConstantDeclaration(value)?.initializer;
    if (initial === undefined) return undefined;
    value = unwrapped(initial);
  }
  if (!isAnswering(value) || answersLater(value) || value.body === undefined) return undefined;
  if (!isBlock(value.body)) return [value.body];
  const [statement, ...remaining] = value.body.statements;
  if (statement === undefined || remaining.length > 0 || !isReturnStatement(statement))
    return undefined;
  return statement.expression === undefined ? [] : [statement.expression];
}

/** Final source-written own fields on literals or native object mutator results. */
function ownMember(expression: Expression, name: string): JsonSelection | undefined {
  let value = unwrapped(expression);
  for (;;) {
    if (isObjectLiteralExpression(value)) return literalMember(value, name);
    if (!isCallExpression(value)) return undefined;
    const call = ownCallMember(value, name);
    if (call === undefined) return undefined;
    if (call.member !== undefined) return call.member;
    if (call.target === undefined) return undefined;
    value = unwrapped(call.target);
  }
}

/** A known native mutator either replaces this member or retains its target's previous value. */
function ownCallMember(
  call: CallExpression,
  name: string,
):
  | { readonly target?: Expression | undefined; readonly member?: JsonSelection | undefined }
  | undefined {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  if (
    path !== 'Object.assign' &&
    path !== 'Object.defineProperty' &&
    path !== 'Object.defineProperties'
  )
    return undefined;
  const prefix = framedArgumentPrefix(call, call.arguments, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return { member: null };
  const [target, key, descriptor] = prefix.values;
  if (target === undefined) return undefined;
  if (path === 'Object.assign')
    return { target, member: assignedMember(prefix.values.slice(1), name) };
  if (key === undefined) return { member: null };
  return {
    target,
    member:
      path === 'Object.defineProperties'
        ? pluralMember(key, name)
        : singularMember(key, descriptor, name),
  };
}

/** A singular definition replaces only the exact selected source-written string key. */
function singularMember(
  key: Expression,
  descriptor: Expression | undefined,
  name: string,
): JsonSelection | undefined {
  const selected = unwrapped(key);
  if (descriptor === undefined || !isStringLiteral(selected)) return null;
  return selected.text === name ? descriptorMember(descriptor) : undefined;
}

/** A literal plural descriptor map supplies one final source-written member descriptor. */
function pluralMember(expression: Expression, name: string): JsonSelection | undefined {
  const map = unwrapped(expression);
  if (!isObjectLiteralExpression(map)) return null;
  const entry = literalMember(map, name);
  if (entry === undefined || entry === null) return entry;
  const single = entry[0];
  return single === undefined || isMethodDeclaration(single) ? null : descriptorMember(single);
}

/** A later literal assign source replaces a definite member; unknown sources retain uncertainty. */
function assignedMember(sources: readonly Expression[], name: string): JsonSelection | undefined {
  for (const source of sources.toReversed()) {
    const value = unwrapped(source);
    if (!isObjectLiteralExpression(value)) return null;
    const own = literalMember(value, name);
    if (own !== undefined) return own;
  }
  return undefined;
}

/** Written fields retain final override order; source-known getters retain direct returned values. */
function literalMember(object: ObjectLiteralExpression, name: string): JsonSelection | undefined {
  const pending = [...object.properties];
  for (let property = pending.pop(); property !== undefined; property = pending.pop()) {
    if (isSpreadAssignment(property)) {
      const spread = unwrapped(property.expression);
      if (!isObjectLiteralExpression(spread)) return null;
      pending.push(...spread.properties);
      continue;
    }
    const key = property.name;
    if (!isIdentifier(key) && !isStringLiteral(key) && !isNumericLiteral(key)) return null;
    if (key.text !== name) continue;
    return literalEntry(property, object, name);
  }
  return undefined;
}

/**
 * Source-known getters are values read now; ordinary method declarations remain function values. A
 * setter keeps a getter of the name beside it in the same literal, whose value is read; one alone
 * reads as nothing.
 */
function literalEntry(
  property: ObjectLiteralElementLike,
  object: ObjectLiteralExpression,
  name: string,
): JsonSelection {
  if (isMethodDeclaration(property)) return [property];
  if (isPropertyAssignment(property)) return [property.initializer];
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    return [property.name];
  if (!isGetAccessorDeclaration(property) && !isSetAccessorDeclaration(property)) return null;
  const sources = framedObjectSources(object, [name]);
  return sources?.every((each) => each.keys.length === 0) === true
    ? sources.map((each) => each.value)
    : null;
}

/** Literal descriptor data or a direct synchronous getter supplies the installed own value. */
function descriptorMember(expression: Expression): JsonSelection {
  const descriptor = unwrapped(expression);
  if (!isObjectLiteralExpression(descriptor)) return null;
  const data = literalMember(descriptor, 'value');
  if (data !== undefined) return data;
  const getter = literalMember(descriptor, 'get');
  if (getter === null) return getter;
  if (getter === undefined || getter.length === 0) return [];
  const values: Expression[] = [];
  for (const fn of getter) {
    const results = directJsonResults(fn);
    if (results === undefined) return null;
    values.push(...results);
  }
  return values;
}

/** An immediately preceding closed own definition keeps its callable or data replacement. */
function previousOwnMember(
  expression: Expression,
  source: JsonValueSource,
  call: Node,
  name: string,
): JsonSelection | undefined {
  let statement = call;
  while (!isBlock(statement.parent) && statement.parent !== statement.getSourceFile())
    statement = statement.parent;
  if (!isBlock(statement.parent)) return undefined;
  const statements = statement.parent.statements;
  const previous = statements[statements.indexOf(statement as Statement) - 1];
  if (previous === undefined || !isExpressionStatement(previous)) return undefined;
  const prior = unwrapped(previous.expression);
  if (!isCallExpression(prior)) return undefined;
  const target = prior.arguments[0];
  if (target === undefined || !sameJsonReceiver(target, expression, source.aliases))
    return undefined;
  return ownMember(prior, name);
}

/** Lexical binding identity prevents an inner same-spelled holder from replacing another value. */
function sameJsonReceiver(
  target: Expression,
  expression: Expression,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  const value = unwrapped(target);
  if (!isIdentifier(value)) return false;
  const current = unwrapped(expression);
  const binding = frameBindingOf(value)?.binding;
  return (
    binding !== undefined &&
    (aliases.has(binding) ||
      (isIdentifier(current) && binding === frameBindingOf(current)?.binding))
  );
}
