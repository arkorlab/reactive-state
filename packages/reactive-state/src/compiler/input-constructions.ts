import {
  type CallExpression,
  type ConstructorDeclaration,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isTaggedTemplateExpression,
  isVoidExpression,
  type NewExpression,
  type Node,
  type TaggedTemplateExpression,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { BUILT_INS, PLATFORM_ALIKE } from './built-ins.ts';
import { globalPathOf } from './code-globals.ts';
import { metadataArguments, metadataParameters, type MetadataSource } from './input-bindings.ts';
import { metadataCallee, metadataInitializer, metadataInvocation } from './input-callees.ts';
import { metadataDefaults } from './input-defaults.ts';
import {
  nativeCallbackRoots,
  nonConstructor,
  reflectedInvocation,
  settlesPromise,
  skipsReviver,
} from './input-native-callbacks.ts';
import { metadataTag } from './input-tags.ts';
import { rootOf } from './kept.ts';
import { constantValue } from './numbers.ts';
import { writtenBy } from './written.ts';

/** Metadata identity and input writes of source-declared constructors and Proxy traps. */

type Callable = Answering | ConstructorDeclaration;
interface Execution {
  readonly root: Node;
  readonly bindings: MetadataSource['bindings'];
  readonly trail: ReadonlySet<Node>;
  readonly executor?: Answering | undefined;
}

interface Invocation {
  readonly callee: Node;
  readonly given: readonly Expression[];
  readonly constructs: boolean;
}

const STRINGIFY = 'JSON.stringify';
const PARSE = 'JSON.parse';
const PROMISE = 'Promise';

/** JSON replacers written as plain values are never callable functions. */
const NONCALLABLE_REPLACERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.TrueKeyword,
]);

/** The native functions whose second argument executes as a synchronous callback. */
const CALLING_SECOND: ReadonlySet<string> = new Set([
  'Array.from',
  'Map.groupBy',
  'Object.groupBy',
  PARSE,
  STRINGIFY,
]);

/** A known global constructor or function, past constant aliases. */
function nativePath(node: Node | undefined): string | undefined {
  return node === undefined ? undefined : globalPathOf(node)?.join('.');
}

/** Whether the global's result is constructed anew, except for the identity wrappers handled first. */
function nativeFresh(path: string | undefined): boolean {
  const [root] = path?.split('.', 2) ?? [];
  return root !== undefined && (BUILT_INS.has(root) || PLATFORM_ALIKE.has(root));
}

/** What a construction may retain, plus input writes its body or Proxy traps can observe. */
export function constructionSources(
  value: NewExpression,
  source: MetadataSource,
): readonly MetadataSource[] | undefined {
  const invoked = metadataInvocation(value);
  if (invoked === undefined) {
    return undefined;
  }
  const { callee, given } = invoked;
  const path = nativePath(callee);
  if (path === 'Object') {
    return given[0] === undefined ? [] : [{ ...source, value: given[0] }];
  }
  if (path === 'Proxy') {
    return proxySources(given, source);
  }
  if (nativeFresh(path)) {
    return [];
  }
  const fields = instanceFields(callee);
  const fn = constructorOf(callee);
  if (fn === undefined) {
    return isImplicitBase(callee) ? executionSources(fields, source.bindings) : undefined;
  }
  const bindings = metadataArguments(fn, given, source.bindings);
  const roots = [...fields, ...invocationRoots(fn, bindings)];
  const effects = executionSources(roots, bindings);
  if (effects === undefined) {
    return undefined;
  }
  return [...effects, ...returnSources(fn, bindings)];
}

/** Selected parameter defaults execute before the body; provided arguments do not evaluate them. */
function invocationRoots(fn: Callable, bindings: MetadataSource['bindings'], body = true): Node[] {
  const roots: Node[] = metadataDefaults(fn, bindings);
  if (body && fn.body !== undefined) {
    roots.push(fn.body);
  }
  return roots;
}

/** An implicit base constructor creates its receiver, rather than delegating to an unknown base. */
function isImplicitBase(node: Node | undefined): boolean {
  return (
    node !== undefined &&
    (isClassDeclaration(node) || isClassExpression(node)) &&
    node.heritageClauses === undefined
  );
}

/** Instance field initializers execute during construction, beside the constructor body. */
function instanceFields(node: Node | undefined): Node[] {
  if (node === undefined || (!isClassDeclaration(node) && !isClassExpression(node))) {
    return [];
  }
  return node.members.flatMap((member) => {
    return isPropertyDeclaration(member) &&
      member.initializer !== undefined &&
      member.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) !== true
      ? [member.initializer]
      : [];
  });
}

/** A source constructor body; no body for an unproven inherited construction. */
function constructorOf(node: Node | undefined): Callable | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (isClassDeclaration(node) || isClassExpression(node)) {
    return node.members.find(
      (member): member is ConstructorDeclaration =>
        isConstructorDeclaration(member) && member.body !== undefined,
    );
  }
  return isFunctionDeclaration(node) || isFunctionExpression(node) ? node : undefined;
}

/** Explicit object-return candidates; primitive returns leave the new receiver fresh. */
function returnSources(fn: Callable, bindings: MetadataSource['bindings']): MetadataSource[] {
  const found: MetadataSource[] = [];
  const visit = (node: Node): void => {
    if (
      isReturnStatement(node) &&
      node.expression !== undefined &&
      unwrapped(node.expression).kind !== SyntaxKind.ThisKeyword &&
      !primitiveReturn(node.expression)
    ) {
      found.push({ bindings, value: node.expression });
    }
    if (!functionCode(node)) {
      node.forEachChild(visit);
    }
  };
  fn.body?.forEachChild(visit);
  return found;
}

/** A primitive expression cannot replace the fresh receiver of a construction. */
function primitiveReturn(node: Expression): boolean {
  const value = unwrapped(node);
  return isVoidExpression(value) || constantValue(value, metadataInitializer) !== undefined;
}

/** Whether a node's body belongs to another execution. */
function functionCode(node: Node): boolean {
  return (
    isAnswering(node) ||
    isConstructorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isClassDeclaration(node) ||
    isClassExpression(node)
  );
}

/** A known Proxy handler's target and source-proven trap effects, followed independently. */
function proxySources(
  given: readonly Expression[],
  source: MetadataSource,
): readonly MetadataSource[] | undefined {
  const [target, supplied] = given;
  const handler = supplied === undefined ? undefined : metadataCallee(supplied);
  if (target === undefined || handler === undefined || !isObjectLiteralExpression(handler)) {
    return undefined;
  }
  const found: MetadataSource[] = [{ ...source, value: target }];
  for (const property of handler.properties) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const key =
      isIdentifier(property.name) ||
      isStringLiteral(property.name) ||
      isNoSubstitutionTemplateLiteral(property.name)
        ? property.name.text
        : undefined;
    if (key === undefined || key === '__proto__') {
      return undefined;
    }
    const trap = trapOf(property);
    if (trap === undefined) {
      return undefined;
    }
    const effects = trapEffects(trap, target, source.bindings);
    if (effects === undefined) {
      return undefined;
    }
    found.push(...effects);
  }
  return found;
}

/** A trap getter executes first, then the source function it returns is invoked with the target. */
function trapEffects(
  trap: Answering,
  target: Expression,
  outer: MetadataSource['bindings'],
): readonly MetadataSource[] | undefined {
  const effects = trapSources(trap, target, outer);
  if (effects === undefined || !isGetAccessorDeclaration(trap)) {
    return effects;
  }
  const found = [...effects];
  for (const returned of returnSources(trap, outer)) {
    const fn = metadataCallee(returned.value);
    if (fn === undefined || !isAnswering(fn)) {
      return undefined;
    }
    const called = trapSources(fn, target, outer);
    if (called === undefined) {
      return undefined;
    }
    found.push(...called);
  }
  return found;
}

/** A trap's parameters are its target and primitive keys; its external captures remain separate. */
function trapSources(
  trap: Answering,
  target: Expression,
  outer: MetadataSource['bindings'],
): readonly MetadataSource[] | undefined {
  const bindings = new Map(outer);
  const parameters = metadataParameters(trap);
  for (const [index, parameter] of parameters.entries()) {
    bindings.set(parameter, index === 0 ? target : undefined);
  }
  return executionSources(trap.body === undefined ? [] : [trap.body], bindings);
}

/** A literal trap method, getter or data function; unknown handlers are not presumed pure. */
function trapOf(node: Node): Answering | undefined {
  if (isMethodDeclaration(node) || isGetAccessorDeclaration(node)) {
    return node;
  }
  let value: Expression | undefined;
  if (isPropertyAssignment(node)) {
    value = node.initializer;
  } else if (isShorthandPropertyAssignment(node) && isIdentifier(node.name)) {
    value = node.name;
  }
  const fn = value === undefined ? undefined : metadataCallee(value);
  return fn !== undefined && isAnswering(fn) ? fn : undefined;
}

/** Input writes reached while a constructor or trap executes, even when call results are discarded. */
function executionSources(
  roots: readonly Node[],
  bindings: MetadataSource['bindings'],
): readonly MetadataSource[] | undefined {
  const pending: Execution[] = roots.map((root) => ({ bindings, root, trail: new Set() }));
  const found: MetadataSource[] = [];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current.trail.has(current.root)) {
      return undefined;
    }
    const trail = new Set([...current.trail, current.root]);
    const execution = current;
    const status = { uncertain: false };
    const visit = (node: Node): void => {
      if (status.uncertain) {
        return;
      }
      const written = writtenBy(node);
      if (
        written !== undefined &&
        (isCallExpression(node) ||
          isPropertyAccessExpression(written) ||
          isElementAccessExpression(written))
      ) {
        const root = rootOf(written);
        if (root !== undefined) {
          found.push({ bindings: execution.bindings, value: root });
        }
      }
      if (isCallExpression(node) || isNewExpression(node)) {
        status.uncertain = !invokedEffects(node, { ...execution, trail }, pending);
      } else if (isTaggedTemplateExpression(node)) {
        status.uncertain = !taggedEffects(node, { ...execution, trail }, pending);
      }
      if (!functionCode(node)) {
        node.forEachChild(visit);
      }
    };
    visit(current.root);
    if (status.uncertain) {
      return undefined;
    }
  }
  return found;
}

/** A source tag runs defaults immediately, while an acquired generator body remains suspended. */
function taggedEffects(
  tag: TaggedTemplateExpression,
  current: Execution,
  pending: Execution[],
): boolean {
  const invoked = metadataTag(tag, current.bindings);
  if (invoked === undefined || readsCallbackReceiver(invoked.fn)) {
    return false;
  }
  const { fn, bindings } = invoked;
  const generator =
    (isFunctionDeclaration(fn) || isFunctionExpression(fn) || isMethodDeclaration(fn)) &&
    fn.asteriskToken !== undefined;
  const roots = invocationRoots(fn, bindings, !generator);
  for (const root of roots) {
    pending.push({ bindings, root, trail: current.trail });
  }
  return fn.body !== undefined;
}

/** A source helper's effects, or the inputs handed to code whose effects the compile cannot show. */
function invokedEffects(
  call: CallExpression | NewExpression,
  current: Execution,
  pending: Execution[],
): boolean {
  if (isCallExpression(call) && settlesPromise(call, current.executor)) {
    return true;
  }
  const invoked = metadataInvocation(call);
  if (invoked === undefined) {
    return false;
  }
  const reflected = nativePath(invoked.callee) === 'Reflect.construct';
  const actual = reflected ? reflectedInvocation(call, invoked.given) : invoked;
  if (actual === undefined) {
    return false;
  }
  const { callee, given } = actual;
  const path = nativePath(callee);
  const constructs = reflected || isNewExpression(call);
  if ((reflected && nonConstructor(callee)) || (path === PROMISE && !constructs)) {
    return true;
  }
  if (nativeFresh(path)) {
    return nativeCallbackEffects(path, given, current, pending);
  }
  return sourceEffects({ callee, constructs, given }, current, pending);
}

/** An application callable executes with its actual argument bindings and fresh receiver fields. */
function sourceEffects(invoked: Invocation, current: Execution, pending: Execution[]): boolean {
  const { callee, given, constructs } = invoked;
  const fn = constructs ? constructorOf(callee) : callee;
  if (
    fn !== undefined &&
    (isAnswering(fn) || isConstructorDeclaration(fn)) &&
    fn.body !== undefined
  ) {
    const bindings = metadataArguments(fn, given, current.bindings);
    const roots = constructs ? instanceFields(callee) : [];
    roots.push(...invocationRoots(fn, bindings));
    for (const root of roots) {
      pending.push({ bindings, root, trail: current.trail });
    }
    return true;
  }
  return false;
}

/** Source callbacks can observe captured input writes even when their native caller's result is unused. */
function nativeCallbackEffects(
  path: string | undefined,
  given: readonly Expression[],
  current: Execution,
  pending: Execution[],
): boolean {
  const callback = given[path === PROMISE ? 0 : 1];
  if (
    callback === undefined ||
    (path !== PROMISE && !callsSecond(path)) ||
    emptyCollection(path, given[0]) ||
    (path === PARSE && skipsReviver(given[0]))
  ) {
    return true;
  }
  const fn = metadataCallee(callback);
  if (fn === undefined) {
    return false;
  }
  if (unusedCallback(fn, path)) {
    return true;
  }
  if (!isAnswering(fn) || fn.body === undefined) {
    return false;
  }
  const roots = nativeCallbackRoots(fn, path, given[0]);
  if (roots === undefined || roots.some((root) => readsCallbackReceiver(root))) {
    return false;
  }
  for (const root of roots) {
    pending.push({ ...current, executor: path === PROMISE ? fn : current.executor, root });
  }
  return true;
}

/** Array and typed-array mapping, stringification, and grouping consume a second callback. */
function callsSecond(path: string | undefined): boolean {
  if (path === undefined || CALLING_SECOND.has(path)) {
    return path !== undefined;
  }
  const suffix = '.from';
  const root = path.slice(0, -suffix.length);
  return path.endsWith(suffix) && root.endsWith('Array') && BUILT_INS.has(root);
}

/** A directly written empty collection calls no mapper or grouping callback. */
function emptyCollection(path: string | undefined, value: Expression | undefined): boolean {
  const collection = value === undefined ? undefined : unwrapped(value);
  return (
    path !== STRINGIFY &&
    collection !== undefined &&
    isArrayLiteralExpression(collection) &&
    collection.elements.length === 0
  );
}

/** Undefined omits an optional mapper; JSON's array replacer lists keys instead of calling code. */
function unusedCallback(node: Node, path = ''): boolean {
  return (
    isVoidExpression(node) ||
    globalPathOf(node)?.join('.') === 'undefined' ||
    ([PARSE, PROMISE, STRINGIFY].includes(path) && isExpression(node) && ignoredReplacer(node))
  );
}

/** JSON ignores proven non-callables, while an array replacer lists names instead of invoking code. */
function ignoredReplacer(node: Expression): boolean {
  return (
    NONCALLABLE_REPLACERS.has(node.kind) || constantValue(node, metadataInitializer) !== undefined
  );
}

/** A callback's this-dependent effects stay unknown until its native receiver binding is followed. */
function readsCallbackReceiver(node: Node): boolean {
  let found = false;
  const visit = (each: Node): void => {
    found ||= each.kind === SyntaxKind.ThisKeyword;
    if (!found) {
      each.forEachChild(visit);
    }
  };
  visit(node);
  return found;
}
