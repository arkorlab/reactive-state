import {
  type BindingElement,
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAwaitExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyAccessExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { overloadsOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf, isTakenApart, useOf } from './code-globals.ts';
import { sourceArrayFunction, sourceArrayMethod } from './framed-array-functions.ts';
import { frameBindingOf, frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { computedBindingContainer, framedKeyNames, framedMemberNames } from './framed-keys.ts';
import { framedSourceValues } from './framed-sources.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { assignedNames, localDateOwnData, localDateOwnMethod } from './local-date-inputs.ts';
import { dateText, localNamed } from './local-reads.ts';
import { renderDateText } from './render-date-text.ts';
import { renderIntlInput } from './render-intl-inputs.ts';
import { reflectedRead } from './render-intl-reflections.ts';
import {
  type BoundArgCount,
  pushBoundTagPaths,
  tagPathKey,
  type TagParameterEnv,
  type TagPath,
} from './render-raw-tag-calls.ts';
import { pushFactoryParameterTagPaths } from './render-raw-tag-envs.ts';
import { expandFactoryCallTagPaths, expandTaggedFactoryPaths } from './render-raw-tag-factories.ts';
import {
  type ObjectTagSink,
  pushArrayCallTagPaths,
  pushArrayIdentifierTagPaths,
  pushArrayLiteralTagPaths,
  pushObjectTagPaths,
} from './render-raw-tag-paths.ts';
import { datedTemplateSpanIndices, wrapperForwardsRawDate } from './render-raw-tag-wrappers.ts';
import type { RawWrapperSearch } from './render-raw-wrapper-bindings.ts';
import { inheritBoundArgCount, matchesDirectRawOrStringTag } from './render-tag-date-calls.ts';
import { isOuterTemplateConsumedAsText } from './render-tag-date-coercions.ts';
import { bindingIdentifiers } from './scope.ts';

/** What a read takes a method of, where the code shows it: the value, and the keys selected within it. */
interface Receiver {
  readonly source: Expression;
  readonly keys: readonly string[];
}

/** What a pattern's entry takes: the names it may take, and what it takes them of. */
interface Taken {
  readonly names: readonly string[] | undefined;
  readonly receiver: Receiver | undefined;
}

/** Locale-sensitive native render reads, with source-proven own functions and local date data retained. */
const LOCALE_MEMBERS: ReadonlySet<string> = new Set([
  'localeCompare',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleUpperCase',
]);
const TAG_SEARCH = { limit: 64 } as const;

/**
 * Native locale members and a formatter's methods — read as a member, by `Reflect.get`, or taken
 * apart — and native Date text retain the render environment as an untracked input.
 */
export function renderLocalInput(node: Node): string | undefined {
  if (isBindingElement(node)) return renderIntlInput(node) ?? patternLocaleMember(node);
  if (isCallExpression(node))
    return (
      renderIntlInput(node) ?? reflectedLocaleMember(node) ?? renderDateText(node) ?? dateText(node)
    );
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    if (writeOnly(node)) return undefined;
    const member = renderIntlInput(node) ?? memberLocaleInput(node);
    if (member !== undefined) return member;
  }
  return patternLocaleMember(node) ?? renderDateText(node) ?? localDateText(node);
}

interface TagExpandSink {
  readonly rootRead: Expression;
  readonly pending: TagPath[];
  readonly methods: MethodDeclaration[];
  readonly env: TagParameterEnv | undefined;
  readonly boundArgs: BoundArgCount | undefined;
  readonly depth: number;
}

/** Tagged templates pass Date substitutions raw unless a tag path can coerce them to local-time text. */
function localDateText(node: Node): string | undefined {
  const text = dateText(node);
  if (
    text !== undefined &&
    isTemplateExpression(node) &&
    isTaggedTemplateExpression(node.parent) &&
    node.parent.template === node &&
    !maySelectNativeRaw(node.parent.tag, {
      datedIndices: datedTemplateSpanIndices(node),
      outerConsumedAsText: isOuterTemplateConsumedAsText(node),
      seenWrappers: new Set(),
      spanCount: node.templateSpans.length,
    })
  )
    return undefined;
  return text;
}

/** Constant, multi-branch, reflected, bound, array, factory and custom tag paths coercing Date values. */
function maySelectNativeRaw(tag: Expression, search: RawWrapperSearch): boolean {
  const pending: TagPath[] = [
    { boundArgs: search.boundArgs, env: search.env, node: tag, suffix: [] },
  ];
  const methods: MethodDeclaration[] = [];
  const seen = new Set<string>();
  let steps = 0;
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    steps += 1;
    if (steps > TAG_SEARCH.limit) return true;
    const value = unwrapped(current.node);
    const key = tagPathKey(value, current.suffix, current.env, current.boundArgs);
    if (seen.has(key)) continue;
    seen.add(key);
    const stepSearch: RawWrapperSearch = {
      ...search,
      boundArgs: current.boundArgs,
      env: current.env,
    };
    if (matchesDirectRawOrStringTag(value, current.suffix, stepSearch)) return true;
    if (current.suffix.length === 0 && matchesRawWrapperTag(value, stepSearch)) return true;
    const prevLength = pending.length;
    const sink: TagExpandSink = {
      boundArgs: current.boundArgs,
      depth: 0,
      env: current.env,
      methods,
      pending,
      rootRead: tag,
    };
    if (globalPathOf(value) === undefined && expandTagPath(value, current.suffix, sink))
      return true;
    inheritBoundArgCount(pending, prevLength, current.boundArgs);
    if (drainWrapperMethods(methods, stepSearch)) return true;
  }
  return false;
}

function drainWrapperMethods(methods: MethodDeclaration[], search: RawWrapperSearch): boolean {
  for (let method = methods.pop(); method !== undefined; method = methods.pop()) {
    if (wrapperForwardsRawDate(method, { ...search, maySelectTag: maySelectNativeRaw }))
      return true;
  }
  return false;
}

function matchesRawWrapperTag(value: Expression, search: RawWrapperSearch): boolean {
  const query = { ...search, maySelectTag: maySelectNativeRaw };
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    return wrapperForwardsRawDate(value, query);
  }
  if (!isIdentifier(value)) return false;
  const declared = frameDeclarationOf(value);
  if (declared === undefined || !isFunctionDeclaration(declared)) return false;
  const impl = overloadsOf(declared).find(
    (candidate): candidate is FunctionDeclaration =>
      isFunctionDeclaration(candidate) && candidate.body !== undefined,
  );
  return impl === undefined || wrapperForwardsRawDate(impl, query);
}

/** Expands one non-global tag expression into the receiver, bound, array, factory or binding sources it may read. */
function expandTagPath(
  value: Expression,
  suffix: readonly (string | undefined)[],
  sink: TagExpandSink,
): boolean {
  if (isCallExpression(value) && suffix.length === 0) {
    const bound = pushBoundTagPaths(
      value,
      (inner, innerSuffix, nextPending, innerEnv) => {
        return expandNonBoundTagPath(inner, innerSuffix, {
          ...sink,
          env: innerEnv,
          pending: nextPending,
        });
      },
      sink.pending,
      { boundArgs: sink.boundArgs, env: sink.env },
    );
    if (bound.exhausted) return true;
    if (bound.handled) return false;
  }
  return expandNonBoundTagPath(value, suffix, sink);
}

function expandNonBoundTagPath(
  value: Expression,
  suffix: readonly (string | undefined)[],
  sink: TagExpandSink,
): boolean {
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    pushMemberTagPaths(value.expression, framedMemberNames(value), suffix, sink);
    return false;
  }
  const sources = framedSourceValues(value);
  if (sources !== undefined) {
    for (const source of sources) sink.pending.push({ env: sink.env, node: source, suffix });
    return false;
  }
  if (isCallExpression(value)) return expandCallTagPath(value, suffix, sink);
  if (isTaggedTemplateExpression(value)) return expandTaggedCallTagPath(value.tag, suffix, sink);
  if (isAwaitExpression(value)) {
    sink.pending.push({ env: sink.env, node: value.expression, suffix });
    return false;
  }
  return expandContainerOrBindingTagPath(value, suffix, sink);
}

function expandCallTagPath(
  call: CallExpression,
  suffix: readonly (string | undefined)[],
  sink: TagExpandSink,
): boolean {
  if (pushReflectedTagPaths(call, suffix, sink)) return false;
  const arrayOutcome = pushArrayCallTagPaths(call, suffix, sink.pending, sink.env);
  if (arrayOutcome === 'exhausted') return true;
  if (arrayOutcome === 'matched') return false;
  return expandFactoryCallTagPaths(call, suffix, sink.env, {
    depth: sink.depth,
    pending: sink.pending,
    step: (inner, innerSuffix, objectSink) =>
      stepFactoryInnerPath(inner, innerSuffix, objectSink, sink),
  });
}

function expandTaggedCallTagPath(
  calleeTag: Expression,
  suffix: readonly (string | undefined)[],
  sink: TagExpandSink,
): boolean {
  return expandTaggedFactoryPaths(calleeTag, suffix, {
    depth: sink.depth,
    env: sink.env,
    pending: sink.pending,
    step: (inner, innerSuffix, objectSink) =>
      stepFactoryInnerPath(inner, innerSuffix, objectSink, sink),
  });
}

function stepFactoryInnerPath(
  inner: Expression,
  innerSuffix: readonly (string | undefined)[],
  objectSink: ObjectTagSink,
  outerSink: TagExpandSink,
): boolean {
  return expandNonBoundTagPath(inner, innerSuffix, {
    boundArgs: outerSink.boundArgs,
    depth: outerSink.depth + 1,
    env: objectSink.env,
    methods: objectSink.methods,
    pending: objectSink.pending,
    rootRead: outerSink.rootRead,
  });
}

function expandContainerOrBindingTagPath(
  value: Expression,
  suffix: readonly (string | undefined)[],
  sink: TagExpandSink,
): boolean {
  if (isArrayLiteralExpression(value) && suffix.length > 0) {
    pushArrayLiteralTagPaths(value, suffix, sink.pending, sink.env);
    return false;
  }
  if (isObjectLiteralExpression(value) && suffix.length > 0) {
    pushObjectTagPaths(value, suffix, sink);
    return false;
  }
  if (isNewExpression(value)) return expandNewTagPath(value, suffix, sink);
  return isIdentifier(value) && pushIdentifierTagPaths(value, suffix, sink);
}

function expandNewTagPath(
  value: Expression & {
    readonly expression: Expression;
    readonly arguments?: readonly Expression[];
  },
  suffix: readonly (string | undefined)[],
  sink: TagExpandSink,
): boolean {
  if (
    suffix.length > 0 &&
    suffix[0] === undefined &&
    globalPathOf(unwrapped(value.expression))?.join('.') === 'Set' &&
    value.arguments?.[0] !== undefined
  ) {
    sink.pending.push({ env: sink.env, node: value.arguments[0], suffix });
    return false;
  }
  return true;
}

function pushReflectedTagPaths(
  call: CallExpression,
  suffix: readonly (string | undefined)[],
  sink: TagExpandSink,
): boolean {
  const read = reflectedRead(call);
  if (read === undefined) return false;
  const names = read.key === undefined ? undefined : framedKeyNames(read.key);
  pushMemberTagPaths(read.target, names, suffix, sink);
  return true;
}

function pushMemberTagPaths(
  receiver: Expression,
  names: readonly string[] | undefined,
  suffix: readonly (string | undefined)[],
  sink: TagExpandSink,
): void {
  if (names === undefined) {
    sink.pending.push({ env: sink.env, node: receiver, suffix: [undefined, ...suffix] });
    return;
  }
  for (const name of names) {
    sink.pending.push({ env: sink.env, node: receiver, suffix: [name, ...suffix] });
  }
}

function pushIdentifierTagPaths(
  name: Identifier,
  suffix: readonly (string | undefined)[],
  sink: TagExpandSink,
): boolean {
  const { env, pending, rootRead } = sink;
  for (const source of framedAssignedSources(name)) {
    pending.push({ env, node: source.value, suffix: [...source.keys, ...suffix] });
  }
  if (pushArrayIdentifierTagPaths(name, suffix, { env, pending, rootRead })) return true;
  const declared = frameDeclarationOf(name);
  if (declared === undefined) return true;
  if (!isVariableDeclaration(declared) && !isParameterDeclaration(declared)) return false;
  if (isParameterDeclaration(declared)) {
    const paramOutcome = pushFactoryParameterTagPaths(name, declared, suffix, { env, pending });
    if (paramOutcome.handled) return paramOutcome.opaque;
  }
  pushDeclaredBindingTagPaths(name, declared, suffix, sink);
  return false;
}

function pushDeclaredBindingTagPaths(
  name: Identifier,
  declared: ParameterDeclaration | VariableDeclaration,
  suffix: readonly (string | undefined)[],
  sink: TagExpandSink,
): void {
  const { env, pending } = sink;
  const bound = bindingElementOf(declared, name.text);
  if (bound?.initializer !== undefined) pending.push({ env, node: bound.initializer, suffix });
  const selected = frameBindingOf(name);
  if (selected !== undefined) {
    if (selected.binding.initializer !== undefined) {
      pending.push({
        env,
        node: selected.binding.initializer,
        suffix: [...selected.keys, ...suffix],
      });
    }
    return;
  }
  if (bound !== undefined) pushComputedBindingTagPaths(bound, suffix, sink);
}

function bindingElementOf(
  declared: ParameterDeclaration | VariableDeclaration,
  text: string,
): BindingElement | undefined {
  const found = bindingIdentifiers(declared.name).find((identifier) => identifier.text === text);
  return found !== undefined && isBindingElement(found.parent) ? found.parent : undefined;
}

function pushComputedBindingTagPaths(
  bound: BindingElement,
  suffix: readonly (string | undefined)[],
  sink: TagExpandSink,
): void {
  const container = computedBindingContainer(bound);
  if (container?.binding.initializer === undefined) return;
  const source = container.binding.initializer;
  const names = framedMemberNames(bound);
  if (names === undefined) {
    sink.pending.push({
      env: sink.env,
      node: source,
      suffix: [...container.keys, undefined, ...suffix],
    });
    return;
  }
  for (const name of names) {
    sink.pending.push({
      env: sink.env,
      node: source,
      suffix: [...container.keys, name, ...suffix],
    });
  }
}

/** Direct, constant-key and multi-branch bracket reads retain native locale methods unless own. */
function memberLocaleInput(
  node: ElementAccessExpression | PropertyAccessExpression,
): string | undefined {
  const name = frameMemberName(node);
  if (name === undefined)
    return localeMemberOf(framedMemberNames(node), { keys: [], source: node.expression });
  if (!LOCALE_MEMBERS.has(name)) return undefined;
  return sourceArrayFunction(node) || localDateOwnData(node) ? undefined : localNamed(name);
}

/**
 * A native locale member a source-known `Reflect.get` reads (`reflectedRead`), as its member read;
 * none by a key the compile cannot read.
 */
function reflectedLocaleMember(node: Node): string | undefined {
  const read = reflectedRead(node);
  if (read?.key === undefined) return undefined;
  return localeMemberOf(framedKeyNames(read.key), { keys: [], source: read.target });
}

/**
 * A native locale member an object pattern takes apart, as its member read: `const {
 * toLocaleString } = Number.prototype`, renamed, by a literal or constant key in brackets, within
 * another pattern, a parameter's or a loop's, or assigned, `({ toLocaleString: format } = value)`;
 * none of a rest, nor by a key the compile cannot read.
 */
function patternLocaleMember(node: Node): string | undefined {
  const taken = takenOf(node);
  return taken === undefined ? undefined : localeMemberOf(taken.names, taken.receiver);
}

/**
 * What an object pattern's entry takes, of what the code shows it takes it of — a variable's or a
 * parameter's initializer, with the keys of the patterns it is within, or what an assignment
 * assigns its pattern written whole — or of what the code does not show: an assignment's pattern
 * within another, an array's, a default's target or a loop's (`isTakenApart`); none of a rest.
 */
function takenOf(node: Node): Taken | undefined {
  if (isBindingElement(node)) {
    if (!isObjectBindingPattern(node.parent) || node.dotDotDotToken !== undefined) return undefined;
    const selected = computedBindingContainer(node);
    const source = selected?.binding.initializer;
    return {
      names: framedMemberNames(node),
      receiver: source === undefined ? undefined : { keys: selected?.keys ?? [], source },
    };
  }
  if (!isPropertyAssignment(node) && !isShorthandPropertyAssignment(node)) return undefined;
  const literal = node.parent;
  return isObjectLiteralExpression(literal) && isTakenApart(literal)
    ? { names: assignedNames(node.name), receiver: assignedReceiver(literal) }
    : undefined;
}

/**
 * What an assignment takes the pattern `literal` apart of, where it is the pattern written whole
 * on its left, `({ toLocaleString: format } = value)`: none where the assignment is itself a
 * pattern's default, whose value it holds where the value taken apart is none.
 */
function assignedReceiver(literal: ObjectLiteralExpression): Receiver | undefined {
  const { at, parent } = useOf(literal);
  return isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === at &&
    !isTakenApart(parent)
    ? { keys: [], source: parent.right }
    : undefined;
}

/**
 * The input of a locale member a read may take by `names`, of any receiver, as the member read's
 * rule says: none of a source-written method (`sourceArrayMethod`) or a date's literal own method
 * of a receiver the code shows.
 */
function localeMemberOf(
  names: readonly string[] | undefined,
  receiver: Receiver | undefined,
): string | undefined {
  const name = names?.find((each) => LOCALE_MEMBERS.has(each) && !ownMethod(receiver, each));
  return name === undefined ? undefined : localNamed(name);
}

/** Whether the code shows the method `receiver` holds by `name` its own: written, or a date's literal. */
function ownMethod(receiver: Receiver | undefined, name: string): boolean {
  if (receiver === undefined) return false;
  const { keys, source } = receiver;
  return (
    sourceArrayMethod(source, [...keys, name]) ||
    (keys.length === 0 && localDateOwnMethod(source, [name]))
  );
}

/** A plain target write or deletion does not read the method stored there. */
function writeOnly(node: Expression): boolean {
  const { at, parent } = useOf(unwrapped(node));
  return (
    isDeleteExpression(parent) ||
    (isBinaryExpression(parent) &&
      parent.operatorToken.kind === SyntaxKind.EqualsToken &&
      parent.left === at)
  );
}
