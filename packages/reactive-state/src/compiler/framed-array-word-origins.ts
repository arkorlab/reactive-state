import {
  type Expression,
  type Identifier,
  type VariableDeclaration,
  type ObjectLiteralExpression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isPropertyAccessExpression,
  isSpreadElement,
  isTypeNode,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { sourceArrayFunction, writtenArrayKey } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { repeatedFrameRead } from './framed-writes.ts';
import { constantValue } from './numbers.ts';
import { readsBinding } from './scope.ts';

/** Positive closed literal origins keep locally written error words and custom array text methods. */

interface KnownWords {
  readonly created: (value: Expression) => boolean;
  readonly custom: (value: Expression) => boolean;
}

interface WordOrigins {
  readonly pending: Expression[];
  readonly bindings: Set<VariableDeclaration>;
  readonly uses: Set<Identifier>;
  array: boolean;
}

/** An unexposed constant literal array whose complete element words are source-known. */
export function writtenArrayWords(value: Expression, known: KnownWords): boolean {
  const origins: WordOrigins = {
    pending: [value],
    bindings: new Set(),
    uses: new Set(),
    array: false,
  };
  for (let next = origins.pending.pop(); next !== undefined; next = origins.pending.pop())
    if (!knownWord(next, known, origins)) return false;
  return origins.array && unexposedBindings(value, origins.bindings, origins.uses);
}

/** Every literal leaf is primitive, a local error construction, or a proven custom array method. */
function knownWord(value: Expression, known: KnownWords, origins: WordOrigins): boolean {
  const each = unwrapped(value);
  if (known.custom(each)) {
    if (!isIdentifier(each)) return false;
    const binding = constantBinding(each);
    if (binding === undefined) return false;
    origins.uses.add(each);
    origins.bindings.add(binding);
    origins.array = true;
    return true;
  }
  if (isPropertyAccessExpression(each) || isElementAccessExpression(each))
    return literalMemberWords(each, origins);
  if (isArrayLiteralExpression(each)) {
    origins.array = true;
    for (const item of each.elements)
      origins.pending.push(isSpreadElement(item) ? item.expression : item);
    return true;
  }
  if (!isIdentifier(each)) return known.created(each) || writtenPrimitive(each);
  const binding = constantBinding(each);
  if (binding === undefined || origins.bindings.has(binding) || binding.initializer === undefined)
    return false;
  origins.uses.add(each);
  origins.bindings.add(binding);
  origins.pending.push(binding.initializer);
  return true;
}

/** Whole lexical constants retain their actual initializer, excluding selected pattern fields. */
function constantBinding(name: Identifier): VariableDeclaration | undefined {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  if (!isVariableDeclaration(binding) || !isIdentifier(binding.name)) return undefined;
  const statement = binding.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    ? binding
    : undefined;
}

/** Primitive literal contents do not hide an error or call application conversion code. */
function writtenPrimitive(value: Expression): boolean {
  return (
    constantValue(value) !== undefined ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword
  );
}

/** Every constant alias identity is checked for earlier and deferred exposure before using its words. */
function unexposedBindings(
  read: Expression,
  bindings: Set<VariableDeclaration>,
  uses: ReadonlySet<Identifier>,
): boolean {
  const names = bindingReads(read.getSourceFile());
  const pending = [...bindings];
  for (let binding = pending.pop(); binding !== undefined; binding = pending.pop()) {
    for (const name of names) {
      const result = knownBindingUse(name, binding, { read, uses });
      if (!result.allowed) return false;
      const { alias } = result;
      if (alias !== undefined && !bindings.has(alias)) {
        bindings.add(alias);
        pending.push(alias);
      }
    }
  }
  return true;
}

/** Type syntax and declaration names cannot expose a runtime array identity. */
function bindingReads(source: Node): readonly Identifier[] {
  const names: Identifier[] = [];
  const pending = [source];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (isIdentifier(node) && readsBinding(node)) names.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return names;
}

/** Only whole constants and selected custom text writes preserve an earlier source identity. */
function knownBindingUse(
  name: Identifier,
  binding: VariableDeclaration,
  context: { readonly read: Expression; readonly uses: ReadonlySet<Identifier> },
): { readonly allowed: boolean; readonly alias?: VariableDeclaration } {
  if (name === binding.name || context.uses.has(name) || frameBindingOf(name)?.binding !== binding)
    return { allowed: true };
  const owner = executionOwner(context.read);
  if (executionOwner(name) !== owner) return { allowed: false };
  if (
    (name.pos >= context.read.pos || destructuredFirst(context.read, name)) &&
    !destructuredFirst(name, context.read) &&
    !repeatedFrameRead(name, context.read, binding, owner)
  )
    return { allowed: true };
  const { parent } = useOf(name);
  if (isVariableDeclaration(parent) && isIdentifier(parent.name)) {
    const alias = constantBinding(parent.name);
    if (
      alias === parent &&
      parent.initializer !== undefined &&
      unwrapped(parent.initializer) === name
    )
      return { allowed: true, alias: parent };
  }
  return { allowed: customMethodWrite(name) };
}

/** Direct custom text methods preserve the existing source-function proof; opaque uses do not. */
function customMethodWrite(name: Identifier): boolean {
  const { at, parent } = useOf(name);
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    parent.expression !== at
  )
    return false;
  const key = frameMemberName(parent);
  if (key !== 'toString' && key !== 'join') return false;
  const assignment = parent.parent;
  return (
    isBinaryExpression(assignment) &&
    assignment.left === parent &&
    assignment.operatorToken.kind === SyntaxKind.EqualsToken &&
    sourceArrayFunction(assignment.right)
  );
}

/** A literal field path preserves word origins only while every whole holder stays unexposed. */
function literalMemberWords(expression: Expression, origins: WordOrigins): boolean {
  const keys: string[] = [];
  let value = unwrapped(expression);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return false;
    keys.unshift(key);
    value = unwrapped(value.expression);
  }
  while (isIdentifier(value)) {
    const binding = constantBinding(value);
    if (binding?.initializer === undefined || origins.bindings.has(binding)) return false;
    origins.uses.add(value);
    origins.bindings.add(binding);
    value = unwrapped(binding.initializer);
  }
  for (const key of keys) {
    if (!isObjectLiteralExpression(value)) return false;
    const selected = literalWordField(value, key);
    if (selected === undefined) return false;
    value = unwrapped(selected);
  }
  origins.pending.push(value);
  return true;
}

/** Only a final literal data field proves its value; getters and opaque spreads retain annotations. */
function literalWordField(object: ObjectLiteralExpression, key: string): Expression | undefined {
  for (const field of object.properties.toReversed()) {
    if (isSpreadAssignment(field)) return undefined;
    const name = writtenArrayKey(field.name);
    if (name === undefined) return undefined;
    if (name !== key) continue;
    return isPropertyAssignment(field) ? field.initializer : undefined;
  }
  return undefined;
}
