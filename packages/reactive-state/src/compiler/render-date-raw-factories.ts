import {
  type ArrayLiteralExpression,
  type Block,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyName,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater, overloadsOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf, frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { assignedNames } from './local-date-inputs.ts';
import { canonicalArrayTagIndex } from './render-raw-tag-paths.ts';
import type { WrapperFunction } from './render-raw-wrapper-bindings.ts';

/** Quiet synchronous factory-call and wrapper-callable resolution for projected Date templates. */

export interface QuietRawProof {
  readonly calls: Set<CallExpression>;
  readonly fields: Set<Expression>;
}

export interface QuietRawWalkState {
  readonly outerConsumer: Expression;
  readonly allowedOwners: Set<Node>;
  readonly proof: QuietRawProof;
  params: ReadonlyMap<ParameterDeclaration, Expression>;
  callScope: number;
  depth: number;
}

interface QuietWrapperStep {
  readonly fn?: WrapperFunction;
  readonly next?: Expression;
}

const QUIET_FACTORY = { depth: 8, limit: 64 } as const;

export function createQuietRawWalkState(outerConsumer: Expression): QuietRawWalkState {
  return {
    allowedOwners: new Set([outerConsumer]),
    callScope: 0,
    depth: 0,
    outerConsumer,
    params: new Map(),
    proof: { calls: new Set(), fields: new Set() },
  };
}

export function hasAllowedQuietOwner(node: Node, state: QuietRawWalkState): boolean {
  for (const anchor of state.allowedOwners) {
    if (framedPrefixSameOwner(node, anchor)) return true;
  }
  return false;
}

export function stepQuietFactoryParameter(
  name: Identifier,
  state: QuietRawWalkState,
): Expression | undefined {
  const declared = frameDeclarationOf(name);
  return declared !== undefined && isParameterDeclarationNode(declared)
    ? state.params.get(declared)
    : undefined;
}

function isParameterDeclarationNode(node: Node): node is ParameterDeclaration {
  return !isVariableDeclaration(node) && !isFunctionDeclaration(node) && 'dotDotDotToken' in node;
}

/** Whole const aliases in an allowed owner, requiring literal containers to remain unexposed. */
export function quietWholeConstInitializer(
  name: Identifier,
  state: QuietRawWalkState,
): Expression | undefined {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  if (
    !hasAllowedQuietOwner(binding, state) ||
    !isVariableDeclaration(binding) ||
    !isVariableDeclarationList(binding.parent) ||
    binding.initializer === undefined
  ) {
    return undefined;
  }
  const statement = binding.parent.parent;
  if (
    !isVariableStatement(statement) ||
    !/^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
  ) {
    return undefined;
  }
  const initial = unwrapped(binding.initializer);
  if (
    (isArrayLiteralExpression(initial) || isObjectLiteralExpression(initial)) &&
    framedQuietSource(name) === undefined
  ) {
    return undefined;
  }
  return binding.initializer;
}

/** Resolves a tag expression (including quiet factory results) to a quiet synchronous callable. */
export function resolveQuietCallableWithState(
  tag: Expression,
  state: QuietRawWalkState,
): WrapperFunction | undefined {
  const tail: string[] = [];
  const seen = new Set<string>();
  let current: Expression | undefined = unwrapped(tag);
  for (let steps = 0; current !== undefined && steps < QUIET_FACTORY.limit; steps += 1) {
    const key = `${String(current.pos)}:${String(current.end)}:${tail.join('.')}@${String(state.callScope)}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const step = stepQuietCallableTarget(current, tail, state);
    if (step === undefined) return undefined;
    if (step.fn !== undefined) return step.fn;
    current = step.next === undefined ? undefined : unwrapped(step.next);
  }
  return undefined;
}

/** Steps a quiet synchronous factory call to its single returned expression. */
export function stepQuietFactoryCall(
  call: CallExpression,
  state: QuietRawWalkState,
): Expression | undefined {
  if (state.depth >= QUIET_FACTORY.depth || !hasAllowedQuietOwner(call, state)) return undefined;
  if (!quietFactoryArguments(call.arguments, state)) return undefined;
  state.depth += 1;
  const fn = resolveQuietCallableWithState(call.expression, state);
  state.depth -= 1;
  if (fn === undefined || answersLater(fn) || fn.body === undefined) return undefined;
  if (!quietFactoryParameters(fn, state)) return undefined;
  const returned = quietFactoryBodyReturn(fn.body, state);
  if (returned === undefined) return undefined;
  applyQuietFactoryBinding(call, fn, returned, state);
  return returned;
}

function applyQuietFactoryBinding(
  call: CallExpression,
  fn: WrapperFunction,
  returned: Expression,
  state: QuietRawWalkState,
): void {
  const nextParams = new Map(state.params);
  for (const [index, param] of fn.parameters.entries()) {
    const supplied = call.arguments[index] ?? param.initializer;
    if (supplied === undefined) {
      nextParams.delete(param);
      continue;
    }
    const unwrappedArg = unwrapped(supplied);
    const mapped = isIdentifier(unwrappedArg)
      ? (stepQuietFactoryParameter(unwrappedArg, state) ?? supplied)
      : supplied;
    nextParams.set(param, mapped);
  }
  state.params = nextParams;
  state.allowedOwners.add(returned);
  state.callScope = call.pos;
  if (framedPrefixSameOwner(call, state.outerConsumer)) state.proof.calls.add(call);
}

function quietFactoryParameters(fn: WrapperFunction, state: QuietRawWalkState): boolean {
  for (const param of fn.parameters) {
    if (!isIdentifier(param.name) || param.dotDotDotToken !== undefined) return false;
    if (param.initializer !== undefined && !isQuietFactoryValue(param.initializer, state, 0)) {
      return false;
    }
  }
  return true;
}

function quietFactoryArguments(args: readonly Expression[], state: QuietRawWalkState): boolean {
  return args.every((arg) => !isSpreadElement(arg) && isQuietFactoryValue(arg, state, 0));
}

function quietFactoryBodyReturn(
  body: Block | Expression,
  state: QuietRawWalkState,
): Expression | undefined {
  if (!isBlock(body)) return unwrapped(body);
  if (body.statements.length === 0) return undefined;
  const last = body.statements.at(-1);
  if (last === undefined || !isReturnStatement(last) || last.expression === undefined) {
    return undefined;
  }
  state.allowedOwners.add(last);
  const prefixStatements = body.statements.slice(0, -1);
  for (const statement of prefixStatements) {
    if (!isQuietFactoryPrefixStatement(statement, state)) return undefined;
  }
  return unwrapped(last.expression);
}

function isQuietFactoryPrefixStatement(statement: Statement, state: QuietRawWalkState): boolean {
  if (
    isFunctionDeclaration(statement) ||
    isTypeAliasDeclaration(statement) ||
    isInterfaceDeclaration(statement)
  ) {
    return true;
  }
  if (!isVariableStatement(statement)) return false;
  const list = statement.declarationList;
  if (!/^const\b/u.test(list.getText(list.getSourceFile()))) return false;
  return list.declarations.every((decl) => {
    return (
      isIdentifier(decl.name) &&
      decl.initializer !== undefined &&
      isQuietFactoryValue(decl.initializer, state, 0)
    );
  });
}

function isQuietFactoryValue(expr: Expression, state: QuietRawWalkState, depth: number): boolean {
  if (depth > QUIET_FACTORY.depth) return false;
  if (framedQuietPrimitive(expr)) return true;
  const value = unwrapped(expr);
  if (isArrowFunction(value) || isFunctionExpression(value) || globalPathOf(value) !== undefined) {
    return true;
  }
  if (isIdentifier(value)) return isQuietFactoryIdentifier(value, state, depth);
  if (isObjectLiteralExpression(value)) return isQuietFactoryObject(value, state, depth);
  if (isArrayLiteralExpression(value)) return isQuietFactoryArray(value, state, depth);
  return false;
}

function isQuietFactoryIdentifier(
  name: Identifier,
  state: QuietRawWalkState,
  depth: number,
): boolean {
  if (stepQuietFactoryParameter(name, state) !== undefined) return true;
  const declared = frameDeclarationOf(name);
  if (declared !== undefined && isFunctionDeclaration(declared)) {
    return hasAllowedQuietOwner(declared, state) && framedAssignedSources(name).length === 0;
  }
  const init = quietWholeConstInitializer(name, state);
  return init !== undefined && isQuietFactoryValue(init, state, depth + 1);
}

function isQuietFactoryObject(
  object: ObjectLiteralExpression,
  state: QuietRawWalkState,
  depth: number,
): boolean {
  for (const prop of object.properties) {
    if (isMethodDeclaration(prop)) continue;
    if (isShorthandPropertyAssignment(prop)) {
      if (!isIdentifier(prop.name) || !isQuietFactoryIdentifier(prop.name, state, depth + 1))
        return false;
      continue;
    }
    if (!isPropertyAssignment(prop) || assignedNames(prop.name)?.length !== 1) return false;
    if (!isQuietFactoryValue(prop.initializer, state, depth + 1)) return false;
  }
  return true;
}

function isQuietFactoryArray(
  array: ArrayLiteralExpression,
  state: QuietRawWalkState,
  depth: number,
): boolean {
  return array.elements.every((element) => {
    return (
      isOmittedExpression(element) ||
      (!isSpreadElement(element) && isQuietFactoryValue(element, state, depth + 1))
    );
  });
}

function stepQuietCallableTarget(
  value: Expression,
  tail: string[],
  state: QuietRawWalkState,
): QuietWrapperStep | undefined {
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    return stepQuietMemberTarget(value, tail, state);
  }
  if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.CommaToken) {
    return framedQuietPrimitive(value.left) ? { next: value.right } : undefined;
  }
  if (tail.length > 0 && isArrayLiteralExpression(value)) return stepQuietArraySlot(value, tail);
  if (tail.length > 0 && isObjectLiteralExpression(value)) return stepQuietObjectSlot(value, tail);
  if (isCallExpression(value)) {
    const next = stepQuietFactoryCall(value, state);
    return next === undefined ? undefined : { next };
  }
  return stepQuietLeafCallable(value, tail.length, state);
}

function stepQuietMemberTarget(
  value: Expression & { readonly expression: Expression },
  tail: string[],
  state: QuietRawWalkState,
): QuietWrapperStep | undefined {
  const name = frameMemberName(value);
  if (name === undefined || !hasAllowedQuietOwner(value, state)) return undefined;
  if (framedPrefixSameOwner(value, state.outerConsumer)) state.proof.fields.add(value);
  tail.unshift(name);
  return { next: value.expression };
}

function stepQuietArraySlot(
  array: ArrayLiteralExpression,
  tail: string[],
): QuietWrapperStep | undefined {
  const index = canonicalArrayTagIndex(tail[0]);
  if (index === undefined || index >= array.elements.length) return undefined;
  for (let slot = 0; slot < index; slot += 1) {
    const before = array.elements[slot];
    if (before !== undefined && isSpreadElement(before)) return undefined;
  }
  const element = array.elements[index];
  if (element === undefined || isOmittedExpression(element) || isSpreadElement(element)) {
    return undefined;
  }
  tail.shift();
  return { next: element };
}

function stepQuietObjectSlot(
  object: ObjectLiteralExpression,
  tail: string[],
): QuietWrapperStep | undefined {
  const [head] = tail;
  if (head === undefined || head === '__proto__') return undefined;
  for (const property of object.properties.toReversed()) {
    const matched = matchQuietObjectEntry(property, head, tail.length);
    if (matched === undefined) continue;
    if (matched.fn === undefined && matched.next === undefined) return undefined;
    tail.shift();
    return matched;
  }
  return undefined;
}

function matchQuietObjectEntry(
  property: ObjectLiteralExpression['properties'][number],
  head: string,
  tailLength: number,
): QuietWrapperStep | undefined {
  if (isSpreadAssignment(property)) return {};
  if (isShorthandPropertyAssignment(property)) {
    if (!isIdentifier(property.name)) return {};
    return property.name.text === head ? { next: property.name } : undefined;
  }
  if (isMethodDeclaration(property)) {
    const hit = matchSolePropertyName(property.name, head);
    if (hit === undefined) return undefined;
    return tailLength === 1 && hit.sole ? { fn: property } : {};
  }
  if (!isPropertyAssignment(property)) return {};
  const hit = matchSolePropertyName(property.name, head);
  if (hit === undefined) return undefined;
  return hit.sole ? { next: property.initializer } : {};
}

function matchSolePropertyName(
  name: PropertyName,
  head: string,
): { readonly sole: boolean } | undefined {
  const names = assignedNames(name);
  if (names === undefined) return { sole: false };
  return names.includes(head) ? { sole: names.length === 1 } : undefined;
}

function stepQuietLeafCallable(
  value: Expression,
  tailLength: number,
  state: QuietRawWalkState,
): QuietWrapperStep | undefined {
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    return tailLength === 0 ? { fn: value } : undefined;
  }
  if (!isIdentifier(value)) return undefined;
  const paramNext = stepQuietFactoryParameter(value, state);
  if (paramNext !== undefined) return { next: paramNext };
  const declared = frameDeclarationOf(value);
  if (declared !== undefined && isFunctionDeclaration(declared)) {
    return resolveFunctionDeclStep(value, declared, tailLength, state);
  }
  const next = quietWholeConstInitializer(value, state);
  return next === undefined ? undefined : { next };
}

function resolveFunctionDeclStep(
  name: Identifier,
  declared: FunctionDeclaration,
  tailLength: number,
  state: QuietRawWalkState,
): QuietWrapperStep | undefined {
  if (
    tailLength !== 0 ||
    !hasAllowedQuietOwner(declared, state) ||
    framedAssignedSources(name).length > 0
  ) {
    return undefined;
  }
  const impl = overloadsOf(declared).find(
    (candidate): candidate is FunctionDeclaration =>
      isFunctionDeclaration(candidate) && candidate.body !== undefined,
  );
  return impl === undefined ? undefined : { fn: impl };
}
