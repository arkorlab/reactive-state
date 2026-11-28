import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  type Node,
  type TypeNode,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isExpressionStatement,
  isExpression,
  isIdentifier,
  isNewExpression,
  isOmittedExpression,
  isSpreadElement,
  isPropertyAccessExpression,
  isElementAccessExpression,
  isSourceFile,
  isStatement,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { argumentArrayExposed, selectedError } from './framed-array-selections.ts';
import {
  frameBindingOf,
  frameMemberName,
  frameTypeOf,
  type FrameBinding,
} from './framed-bindings.ts';
import { framedInstalledMethods, framedMutatorsInstalled } from './framed-collection-prototypes.ts';
import { framedDeclaredAdmitted } from './framed-declared-collections.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { repeatedFrameRead } from './framed-writes.ts';
import { namesLocalMemberType, namesLocalTypeArgument } from './local-type-reading.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Source-known native collection forEach callbacks receive their original elements, values and keys. */

const SETS = new Set(['ReadonlySet', 'Set']);
const MAPS = new Set(['Map', 'ReadonlyMap']);

type ElementProof = Parameters<typeof selectedError>[2];

interface CallbackContext {
  readonly parameter: number;
  readonly keys: readonly string[];
  readonly names: ReadonlySet<string>;
  readonly call: CallExpression;
}

interface Collection {
  readonly value: Expression;
  readonly bindings: ReadonlySet<FrameBinding>;
  readonly type: TypeNode | undefined;
  readonly map: boolean;
}

/** Both Set value parameters share an origin; a Map callback receives its value before its key. */
export function framedCollectionCallbackError(
  receiver: Expression,
  proof: ElementProof,
  context: CallbackContext,
): boolean | undefined {
  const source = collectionSource(receiver);
  if (source === undefined) return undefined;
  if (ownCallback(source, context.call, receiver)) return false;
  const file = context.call.getSourceFile();
  const kind = source.map ? 'Map' : 'Set';
  if (
    framedInstalledMethods(file, kind, 'forEach').length === 0 &&
    !framedMutatorsInstalled(file, kind)
  )
    return nativeCallbackError(source, proof, context);
  // A forEach the prototype may replace, or a mutator that stores what it hands on, hands its
  // callback what the reader cannot read.
  return nativeCallbackError(source, proof, context) === true || installedAdmits(source, context)
    ? true
    : undefined;
}

/**
 * What a native forEach hands a callback parameter from a fresh collection's written input or a
 * declared one's type; see `framedCollectionCallbackError`.
 */
function nativeCallbackError(
  source: Collection,
  proof: ElementProof,
  context: CallbackContext,
): boolean | undefined {
  const { value } = source;
  if (isNewExpression(value)) {
    const entries = value.arguments?.[0];
    if (entries === undefined) return false;
    if (!source.map) return selectedError(entries, undefined, proof, value);
    const index = context.parameter === 0 ? 1 : 0;
    const pairs = remainingMapEntries(entries);
    if (pairs !== undefined) return pairs.some((pair) => selectedError(pair, index, proof, value));
    return selectedError(
      entries,
      undefined,
      {
        error: (entry, path = []) => path.length === 0 && selectedError(entry, index, proof, value),
        typed: () => false,
      },
      value,
    );
  }
  const argument = source.map && context.parameter === 0 ? 1 : 0;
  return (
    context.keys.length === 0 &&
    namesLocalTypeArgument(source.type, source.map ? MAPS : SETS, argument, context.names)
  );
}

/**
 * Whether what a replaced forEach may hand the callback parameter may be an Error: anything where
 * no type is declared, else what the declared type admits at the read keys: the construction's
 * own, else the annotation's, past local aliases (`framedDeclaredAdmitted`).
 */
function installedAdmits(source: Collection, context: CallbackContext): boolean {
  const { value, type } = source;
  const written = isNewExpression(value) ? value.typeArguments : undefined;
  const argument = source.map && context.parameter === 0 ? 1 : 0;
  const kind = source.map ? 'Map' : 'Set';
  return framedDeclaredAdmitted({ written, annotation: type }, kind, argument, context.keys);
}

/** A last entry with the same written primitive key replaces that Map value before callbacks run. */
function remainingMapEntries(input: Expression): readonly Expression[] | undefined {
  const source = literalEntries(input);
  if (source === undefined || argumentArrayExposed(input, source.bindings)) return undefined;
  const pairs: Expression[] = [];
  const known = new Set<PrimitiveKey['value']>();
  for (const element of source.array.elements.toReversed()) {
    const entry = unwrapped(element);
    if (
      !isArrayLiteralExpression(entry) ||
      entry.elements.some((each) => isSpreadElement(each) || isOmittedExpression(each))
    )
      return undefined;
    const key = entry.elements[0];
    if (key === undefined) return undefined;
    const primitive = primitiveKey(unwrapped(key));
    if (primitive !== undefined) {
      if (known.has(primitive.value)) continue;
      known.add(primitive.value);
    }
    pairs.push(entry);
  }
  return pairs;
}

interface PrimitiveKey {
  readonly value: number | string | boolean | null | undefined;
}

/** Native Map keys keep primitive identity, including literal nullish and boolean values. */
function primitiveKey(node: Expression): PrimitiveKey | undefined {
  if (node.kind === SyntaxKind.TrueKeyword) return { value: true };
  if (node.kind === SyntaxKind.FalseKeyword) return { value: false };
  if (node.kind === SyntaxKind.NullKeyword) return { value: null };
  if (globalPathOf(node)?.join('.') === 'undefined') return { value: undefined };
  const value = constantValue(node);
  return value === undefined ? undefined : { value };
}

/** Unexposed whole constant entry lists retain literal pairs at the constructor's capture position. */
function literalEntries(node: Expression):
  | {
      readonly array: ArrayLiteralExpression;
      readonly bindings: ReadonlySet<FrameBinding>;
    }
  | undefined {
  let value = unwrapped(node);
  const bindings = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || bindings.has(selected.binding))
      return undefined;
    const { binding } = selected;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    bindings.add(binding);
    value = unwrapped(binding.initializer);
  }
  return isArrayLiteralExpression(value) && !value.elements.some((each) => isSpreadElement(each))
    ? { array: value, bindings }
    : undefined;
}

/** Whole immutable aliases retain a native construction, or its explicit native parameter type. */
function collectionSource(node: Expression): Collection | undefined {
  let value = unwrapped(node);
  const bindings = new Set<FrameBinding>();
  let type = frameTypeOf(node)?.type;
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || bindings.has(selected.binding))
      return undefined;
    const { binding } = selected;
    bindings.add(binding);
    type ??= binding.type;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      break;
    value = unwrapped(binding.initializer);
  }
  const sets = isNewExpression(value)
    ? framedNativeConstructor(value.expression, SETS)
    : namesLocalMemberType(type, [], SETS);
  const map = isNewExpression(value)
    ? framedNativeConstructor(value.expression, MAPS)
    : namesLocalMemberType(type, [], MAPS);
  return sets || map ? { value, bindings, type, map } : undefined;
}

/** A fresh collection's immediately preceding unexposed own callable replaces native forEach. */
function ownCallback(source: Collection, call: CallExpression, receiver: Expression): boolean {
  if (!isNewExpression(source.value) || source.bindings.size === 0) return false;
  let statement: Node = call;
  while (!isSourceFile(statement.parent) && !isBlock(statement.parent))
    statement = statement.parent;
  if (!isStatement(statement)) return false;
  const statements = statement.parent.statements;
  const previous = statements[statements.indexOf(statement) - 1];
  if (previous === undefined || !isExpressionStatement(previous)) return false;
  const assignment = unwrapped(previous.expression);
  if (!isBinaryExpression(assignment) || assignment.operatorToken.kind !== SyntaxKind.EqualsToken)
    return false;
  const member = unwrapped(assignment.left);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'forEach' ||
    !sourceArrayFunction(assignment.right)
  )
    return false;
  const target = unwrapped(member.expression);
  if (!isIdentifier(target)) return false;
  const selected = frameBindingOf(target);
  return (
    selected?.keys.length === 0 &&
    source.bindings.has(selected.binding) &&
    !exposedCollection(source, { call, receiver, target })
  );
}

/** Earlier effects, argument reads and possible other-owner uses do not prove an own method write. */
function exposedCollection(
  source: Collection,
  context: {
    readonly call: CallExpression;
    readonly receiver: Expression;
    readonly target: Identifier;
  },
): boolean {
  const pending: Node[] = [context.call.getSourceFile()];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeOnly(at)) continue;
    if (isIdentifier(at) && exposedRead(at, source, context)) return true;
    at.forEachChild((each) => {
      pending.push(each);
    });
  }
  return false;
}

/** Whole aliases, declarations and this exact method selection preserve one fresh collection identity. */
function exposedRead(
  name: Identifier,
  source: Collection,
  context: {
    readonly call: CallExpression;
    readonly receiver: Expression;
    readonly target: Identifier;
  },
): boolean {
  if (!readsBinding(name)) return false;
  const selected = frameBindingOf(name);
  if (selected === undefined || !source.bindings.has(selected.binding)) return false;
  if (
    name === selected.binding.name ||
    name === context.target ||
    name === unwrapped(context.receiver)
  )
    return false;
  const owner = executionOwner(context.call);
  if (executionOwner(name) !== owner) return true;
  if (
    (name.pos > context.call.end || destructuredFirst(context.call, name)) &&
    !repeatedFrameRead(name, context.call, selected.binding, owner)
  )
    return false;
  const { parent, at } = useOf(name);
  return !(
    isExpression(at) &&
    isVariableDeclaration(parent) &&
    parent.initializer === at &&
    isIdentifier(parent.name) &&
    source.bindings.has(parent)
  );
}
