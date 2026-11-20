import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isElementAccessExpression,
  isExpression,
  isCallExpression,
  isClassExpression,
  isSetAccessorDeclaration,
  isSpreadElement,
  type CallExpression,
  isNewExpression,
  type NewExpression,
  isSourceFile,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type Statement,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { type Answering, isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { memberPath } from './exported-values.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietSource } from './framed-native-evaluation.ts';
import { declarationOf, initializerOf } from './framed.ts';
import { targetsOf } from './kept.ts';
import { readsOf } from './local-module-reads.ts';
import { memberChain } from './local-write-paths.ts';
import { writesOf } from './local-writes.ts';
import { middlewareArrayComparison } from './middleware-array-elements.ts';
import { middlewareCallbackHandoff } from './middleware-callback-handoffs.ts';
import { middlewareCopiedCollections } from './middleware-enumerations.ts';
import {
  middlewareLiteralCollection,
  middlewareLiteralContents,
} from './middleware-literal-containers.ts';
import { selectedValue } from './middleware-selected-values.ts';
import { bindingIdentifiers, readsBinding } from './scope.ts';
import { writtenBy } from './written.ts';

/** Whether a literal collection copied into both middleware parts is mutated between those parts. */

interface Constant {
  readonly statement: Statement;
  readonly declares: readonly string[];
}

const PRIMITIVES = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TrueKeyword,
]);

/** Methods whose result holds the array's own elements, as a shallow copy does. */
const COPYING_METHODS: ReadonlySet<string> = new Set([
  'concat',
  'entries',
  'filter',
  'flat',
  'slice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'values',
  'with',
]);

const READ_ONLY_CALLS = new Set([
  'Boolean',
  'Number',
  'Object.entries',
  'Object.getOwnPropertyDescriptor',
  'Object.getOwnPropertyDescriptors',
  'Object.getOwnPropertyNames',
  'Object.getOwnPropertySymbols',
  'Object.getPrototypeOf',
  'Object.hasOwn',
  'Object.is',
  'Object.isExtensible',
  'Object.isFrozen',
  'Object.isSealed',
  'Object.keys',
  'Object.values',
  'Reflect.get',
  'Reflect.getOwnPropertyDescriptor',
  'Reflect.getPrototypeOf',
  'Reflect.has',
  'Reflect.isExtensible',
  'Reflect.ownKeys',
  'String',
]);

/** The first shared collection whose mutable identity the host also reads, through constant aliases. */
export function mutatedSharedConstant<T extends Constant>(
  constants: readonly T[],
  readByBoth: (constant: T) => boolean,
  readOnHost: (name: string) => boolean,
): T | undefined {
  const reached = hostIdentities(constants, readOnHost);
  for (const constant of constants) {
    if (!readByBoth(constant) || !isVariableStatement(constant.statement)) continue;
    for (const declaration of constant.statement.declarationList.declarations) {
      const { name, initializer } = declaration;
      if (initializer === undefined || !isIdentifier(name) || !reached.has(name.text)) continue;
      const value = unwrapped(initializer);
      if (!isObjectLiteralExpression(value) && !isArrayLiteralExpression(value)) continue;
      if (mutated(declaration, name)) return constant;
    }
  }
  return undefined;
}

/**
 * Whether what `name` holds — a collection a default of the middleware's context's pattern gives —
 * is written or handed to a call that may write it where it is bound, as a shared constant's is.
 */
export function mutatedCollection(name: Identifier, initializer: Expression | undefined): boolean {
  return unsafeCollection(name, initializer, ownerOf(name), new Set());
}

/** Host value dependencies stop at a proven copied primitive, rather than retaining its container. */
function hostIdentities(
  constants: readonly Constant[],
  readOnHost: (name: string) => boolean,
): ReadonlySet<string> {
  const declarations = constantDeclarations(constants);
  const pending = [...declarations.keys()].filter((name) => readOnHost(name));
  const reached = new Set<string>();
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) continue;
    reached.add(name);
    const initializer = declarations.get(name)?.initializer;
    if (initializer === undefined || primitiveSnapshot(initializer)) continue;
    pending.push(...identityReads(initializer));
  }
  return reached;
}

/** The identities an initializer retains, including reads delayed beyond its copied primitives. */
function identityReads(initializer: Expression): readonly string[] {
  const names: string[] = [];
  const nodes: { readonly node: Node; readonly immediate: boolean }[] = [
    { immediate: true, node: initializer },
  ];
  for (let each = nodes.pop(); each !== undefined; each = nodes.pop()) {
    const { node } = each;
    const immediate =
      each.immediate &&
      !isAnswering(node) &&
      !isClassExpression(node) &&
      !isSetAccessorDeclaration(node);
    if (immediate && isExpression(node) && primitiveSnapshot(node)) continue;
    if (isIdentifier(node) && readsBinding(node)) names.push(node.text);
    node.forEachChild((child) => {
      nodes.push({ immediate, node: child });
    });
  }
  return names;
}

/** Each pure constant name retains the written declaration its host copy would evaluate. */
function constantDeclarations(
  constants: readonly Constant[],
): ReadonlyMap<string, VariableDeclaration> {
  const declarations = new Map<string, VariableDeclaration>();
  for (const constant of constants) {
    if (!isVariableStatement(constant.statement)) continue;
    for (const declaration of constant.statement.declarationList.declarations) {
      for (const name of bindingIdentifiers(declaration.name)) {
        declarations.set(name.text, declaration);
      }
    }
  }
  return declarations;
}

/** Written updates, native mutating methods and writes through lexical aliases in this middleware. */
function mutated(declaration: VariableDeclaration, name: Identifier): boolean {
  return unsafeCollection(name, declaration.initializer, ownerOf(declaration), new Set());
}

/** A collection's writes or escapes into a call whose corresponding parameter is not proven readonly. */
function unsafeCollection(
  name: Identifier,
  initializer: Expression | undefined,
  owner: Node,
  visiting: ReadonlySet<Identifier>,
): boolean {
  if (visiting.has(name)) return true;
  const inner = new Set([...visiting, name]);
  const found = writesOf(name, initializer, {
    owner,
    visiting: new Set(),
    calls: { functionOf: sourceFunction },
  });
  return (
    found.changes ||
    found.values.length > 0 ||
    writtenMutation(owner, name) ||
    escapes(owner, name, inner) ||
    copied(owner, name)
  );
}

/**
 * Whether the code copies the collection, as a shallow copy does: the copy holds its elements
 * themselves, so what the code does to them through it is not followed, and the copy is refused
 * wherever it goes, bound or not. A name bound to the whole collection is read as the collection is.
 * A member of it is not read: `params.id.slice(0, 8)` copies a text.
 */
function copied(owner: Node, declared: Identifier): boolean {
  const names = [declared];
  const seen = new Set(names);
  for (let name = names.pop(); name !== undefined; name = names.pop()) {
    const isRead = readsOf(name, owner);
    const pending: Node[] = [owner];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (isRead(node)) {
        const { keys, top } = memberChain(node);
        if (makesCopy(top, keys)) return true;
        const alias = wholeName(top, keys);
        if (alias !== undefined && !seen.has(alias)) {
          seen.add(alias);
          names.push(alias);
        }
      }
      node.forEachChild((child) => {
        pending.push(child);
      });
    }
  }
  return false;
}

/** Whether `top`, a read of the collection reached by `keys`, is what a shallow copy of it is made of. */
function makesCopy(top: Expression, keys: readonly (string | undefined)[]): boolean {
  const { parent } = top;
  if (isCallExpression(parent) && parent.expression === top) {
    const [method, ...rest] = keys;
    return method !== undefined && rest.length === 0 && COPYING_METHODS.has(method);
  }
  return keys.length === 0 && isSpreadElement(parent) && isArrayLiteralExpression(parent.parent);
}

/** The name a whole collection is bound to by a declaration, `const alias = collection`. */
function wholeName(top: Expression, keys: readonly (string | undefined)[]): Identifier | undefined {
  const { parent } = top;
  return keys.length === 0 &&
    isVariableDeclaration(parent) &&
    parent.initializer === top &&
    isIdentifier(parent.name)
    ? parent.name
    : undefined;
}

/** The lexical callable containing a declaration, rather than the whole application. */
function ownerOf(node: Node): Node {
  let owner = node;
  while (!isSourceFile(owner) && !isAnswering(owner)) owner = owner.parent;
  return owner;
}

/** Identity-preserving collection arguments passed beyond a known readonly callable. */
function escapes(owner: Node, declared: Identifier, visiting: ReadonlySet<Identifier>): boolean {
  const pending: Node[] = [owner];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if ((isCallExpression(node) || isNewExpression(node)) && unsafeCall(node, declared, visiting))
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Native reads and source-written pure parameter uses do not escape a collection. */
function unsafeCall(
  call: CallExpression | NewExpression,
  declared: Identifier,
  visiting: ReadonlySet<Identifier>,
): boolean {
  const global = globalPathOf(unwrapped(call.expression))?.join('.');
  if (global === 'JSON.stringify') return serializationMutation(call, declared, visiting);
  if (global !== undefined && READ_ONLY_CALLS.has(global)) return false;
  if (isCallExpression(call)) {
    const compared = middlewareArrayComparison(call);
    if (compared !== undefined && collectionArgument(compared, declared)) return true;
    if (callbackMutation(call, declared, visiting)) return true;
  }
  const fn = isCallExpression(call) ? sourceFunction(call.expression) : undefined;
  return (call.arguments ?? []).some((argument, index) => {
    if (!collectionArgument(argument, declared)) return false;
    const parameter = fn === undefined ? undefined : parametersOf(fn)[index];
    return (
      parameter === undefined ||
      bindingIdentifiers(parameter.name).some((name) =>
        unsafeCollection(name, undefined, fn ?? ownerOf(name), visiting),
      )
    );
  });
}

/** Native callback arguments retain their original identities even through named callables. */
function callbackMutation(
  call: CallExpression,
  declared: Identifier,
  visiting: ReadonlySet<Identifier>,
): boolean {
  const given = middlewareCallbackHandoff(call, (value) => selectedValue(value)?.value);
  if (given === undefined || !collectionArgument(given.receiver, declared)) return false;
  if (given.unknown) return true;
  const expression = given.callback;
  if (expression === undefined) return false;
  const value = framedQuietSource(expression);
  if (value !== undefined && nonCallback(value)) return false;
  const fn = sourceFunction(expression);
  if (value === undefined || fn?.body === undefined || replacedReplacer(value) || replacerThis(fn))
    return true;
  return parametersOf(fn).some((parameter, index) => {
    const rest = parameter.dotDotDotToken !== undefined;
    const handed = rest ? given.slots.some((slot) => slot >= index) : given.slots.includes(index);
    if (!handed || (!rest && given.primitiveItems && index !== given.arraySlot)) return false;
    return bindingIdentifiers(parameter.name).some((name) =>
      unsafeCollection(name, undefined, fn, visiting),
    );
  });
}

/** A source-known noncallable performs no callback invocation. */
function nonCallback(value: Expression): boolean {
  return (
    PRIMITIVES.has(value.kind) ||
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    isClassExpression(value) ||
    globalPathOf(value)?.join('.') === 'undefined'
  );
}

/** Only a source-proven readonly replacer keeps native serialization from escaping a collection. */
function serializationMutation(
  call: CallExpression | NewExpression,
  declared: Identifier,
  visiting: ReadonlySet<Identifier>,
): boolean {
  const given = framedArgumentPrefix(call);
  const value = given.values[0];
  if (value === undefined || !collectionArgument(value, declared)) return false;
  return given.unknown || !readonlyReplacer(given.values[1], visiting);
}

/** A literal noncallback is ignored or lists properties; a local callback must keep its inputs. */
function readonlyReplacer(
  expression: Expression | undefined,
  visiting: ReadonlySet<Identifier>,
): boolean {
  if (expression === undefined) return true;
  const value = framedQuietSource(expression);
  if (value === undefined) return false;
  if (
    PRIMITIVES.has(value.kind) ||
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    globalPathOf(value)?.join('.') === 'undefined'
  )
    return true;
  const fn = sourceFunction(expression);
  if (fn?.body === undefined || replacerThis(fn)) return false;
  if (replacedReplacer(value)) return false;
  return parametersOf(fn).every((parameter) => {
    return bindingIdentifiers(parameter.name).every(
      (name) => !unsafeCollection(name, undefined, fn, visiting),
    );
  });
}

/** A replaced lexical function binding adds no callable snapshot proof, even through a constant alias. */
function replacedReplacer(value: Expression): boolean {
  if (!isIdentifier(value)) return false;
  const declaration = declarationOf(value);
  const pending: Node[] = [value.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const written = writtenBy(node);
    if (
      written !== undefined &&
      targetsOf(written).some(
        (target) => isIdentifier(target) && declarationOf(target) === declaration,
      )
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** A native replacer's supplied receiver remains opaque rather than inventing a readonly proof. */
function replacerThis(fn: Answering): boolean {
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.kind === SyntaxKind.ThisKeyword) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** A whole lexical alias or an explicitly selected nested collection keeps the original identity. */
function collectionArgument(argument: Expression, declared: Identifier): boolean {
  const pending = [argument];
  const seen = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next);
    if (seen.has(value)) continue;
    seen.add(value);
    const path = memberPath(value);
    if (!isIdentifier(path.root) || !sameCollection(path.root, declared)) {
      if (reflectedCollection(value, declared)) return true;
      pending.push(...middlewareLiteralContents(value));
      continue;
    }
    const selected = selectedValue(value)?.value;
    if (
      selected !== undefined &&
      (isObjectLiteralExpression(selected) || isArrayLiteralExpression(selected))
    )
      return true;
    if (path.keys.length === 0 && wholeAlias(path.root, declared)) return true;
  }
  return false;
}

/** Bare aliases retain a parameter's identity even where its actual collection is not written in its body. */
function wholeAlias(reference: Identifier, declared: Identifier): boolean {
  const isRead = readsOf(declared, ownerOf(declared));
  const seen = new Set<Identifier>();
  let current: Identifier | undefined = reference;
  while (current !== undefined && !seen.has(current)) {
    if (isRead(current)) return true;
    seen.add(current);
    const initializer = initializerOf(current);
    const value = initializer === undefined ? undefined : unwrapped(initializer);
    current = value !== undefined && isIdentifier(value) ? value : undefined;
  }
  return false;
}

/** Counts and deletes, alongside native mutating calls, retain the declaration of their receiver. */
function writtenMutation(owner: Node, declared: Identifier): boolean {
  const pending: Node[] = [owner];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const written = writtenBy(node);
    if (
      written !== undefined &&
      targetsOf(written).some((target) => changedReceiver(target, node, declared))
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Replacing a primitive binding is distinct from writing a member or a mutating call's receiver. */
function changedReceiver(target: Node, operation: Node, declared: Identifier): boolean {
  if (
    !isPropertyAccessExpression(target) &&
    !isElementAccessExpression(target) &&
    !isCallExpression(operation)
  )
    return false;
  const root = memberPath(target as Expression).root;
  if (isIdentifier(root) && sameCollection(root, declared)) return true;
  const receiver =
    !isCallExpression(operation) &&
    (isPropertyAccessExpression(target) || isElementAccessExpression(target))
      ? target.expression
      : (target as Expression);
  return reflectedCollection(receiver, declared);
}

/** A reflected own data collection retains the original literal's lexical declaration. */
function reflectedCollection(expression: Expression, declared: Identifier): boolean {
  const original = selectedValue(expression);
  const selected =
    original?.reflected === true ? original : middlewareLiteralCollection(expression);
  const copies = middlewareCopiedCollections(expression).flatMap((origin) => {
    const value = selectedValue(origin.of, origin.keys);
    return value === undefined
      ? []
      : [{ ...value, references: [...value.references, ...origin.references] }];
  });
  const candidates = selected === undefined ? copies : [selected, ...copies];
  const isRead = readsOf(declared, ownerOf(declared));
  return candidates.some((candidate) => {
    return (
      (isObjectLiteralExpression(candidate.value) || isArrayLiteralExpression(candidate.value)) &&
      candidate.references.some((reference) => reference === declared || isRead(reference))
    );
  });
}

/** A receiver's original lexical collection through whole or member aliases. */
function sameCollection(reference: Identifier, declared: Identifier): boolean {
  const isRead = readsOf(declared, ownerOf(declared));
  const seen = new Set<Identifier>();
  let current: Identifier | undefined = reference;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (isRead(current)) return true;
    const initializer = initializerOf(current);
    const root = initializer === undefined ? undefined : memberPath(initializer).root;
    current = root !== undefined && isIdentifier(root) ? root : undefined;
  }
  return false;
}

/** A directly written local callable, following only unchanged lexical constant aliases. */
function sourceFunction(callee: Expression): Answering | undefined {
  const seen = new Set<Expression>();
  let value = unwrapped(callee);
  while (isIdentifier(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const declaration = declarationOf(value);
    if (declaration !== undefined && isAnswering(declaration)) return declaration;
    const initializer = initializerOf(value);
    if (initializer === undefined) return undefined;
    value = unwrapped(initializer);
  }
  return isAnswering(value) ? value : undefined;
}

/** A literal or selected literal member that is already a primitive when the constant is declared. */
function primitiveSnapshot(expression: Expression): boolean {
  const selected = selectedValue(expression);
  if (selected === undefined) return false;
  if (
    selected.reflected &&
    (!selected.quiet ||
      selected.references.some((reference) => framedQuietSource(reference) === undefined))
  )
    return false;
  const { value } = selected;
  return (
    PRIMITIVES.has(value.kind) ||
    (isIdentifier(value) && value.text === 'undefined' && declarationOf(value) === undefined)
  );
}
