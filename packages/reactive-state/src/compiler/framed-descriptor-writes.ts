import {
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedDescriptorEntries } from './framed-descriptor-entries.ts';
import { framedArgumentPrefix, framedMemberNames } from './framed-keys.ts';
import { framedPossibleBranch } from './framed-writes.ts';
import { isTypeOnly } from './scope.ts';

/** Source-written replacements of a native descriptor's mutable data value. */
export function framedDescriptorWrites(node: Expression): readonly Expression[] {
  const aliases = descriptorAliases(node);
  if (aliases.size === 0) return [];
  const values: Expression[] = [];
  const owner = executionOwner(node);
  const pending: Node[] = [node.getSourceFile()];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeOnly(at)) continue;
    if (
      (isBinaryExpression(at) || isCallExpression(at)) &&
      (executionOwner(at) !== owner || at.pos < node.pos || destructuredFirst(at, node)) &&
      framedPossibleBranch(at)
    )
      values.push(...writtenValues(at, aliases));
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return values;
}

/** Whole const aliases preserve the same descriptor, including aliases used only for a write. */
function descriptorAliases(node: Expression): ReadonlySet<VariableDeclaration> {
  const aliases = new Set<VariableDeclaration>();
  let value = unwrapped(node);
  while (isIdentifier(value)) {
    const declared = frameDeclarationOf(value);
    if (declared === undefined || !wholeConstant(declared) || aliases.has(declared)) break;
    aliases.add(declared);
    value = unwrapped(declared.initializer);
  }
  const pending: Node[] = [node.getSourceFile()];
  const declarations: (VariableDeclaration & { readonly initializer: Expression })[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeOnly(at)) continue;
    if (wholeConstant(at)) declarations.push(at);
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  let count = -1;
  while (count !== aliases.size) {
    count = aliases.size;
    for (const declared of declarations) {
      const initializer = unwrapped(declared.initializer);
      if (sameDescriptor(initializer, aliases)) aliases.add(declared);
    }
  }
  return aliases;
}

/** Only whole immutable aliases keep their initial descriptor identity. */
function wholeConstant(
  node: Node,
): node is VariableDeclaration & { readonly initializer: Expression } {
  return (
    isVariableDeclaration(node) &&
    isIdentifier(node.name) &&
    isVariableDeclarationList(node.parent) &&
    /^const\s/u.test(node.parent.getText(node.getSourceFile())) &&
    node.initializer !== undefined
  );
}

/** A lexical descriptor alias, without equating unrelated names or destructured values. */
function sameDescriptor(value: Expression, aliases: ReadonlySet<VariableDeclaration>): boolean {
  if (!isIdentifier(value)) return false;
  const declared = frameDeclarationOf(value);
  return declared !== undefined && isVariableDeclaration(declared) && aliases.has(declared);
}

/** Direct value assignments and native Object.assign data entries keep their written RHS. */
function writtenValues(
  node: Node,
  aliases: ReadonlySet<VariableDeclaration>,
): readonly Expression[] {
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
    const target = unwrapped(node.left);
    if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) return [];
    if (!sameDescriptor(unwrapped(target.expression), aliases)) return [];
    const names = framedMemberNames(target);
    return names === undefined || names.includes('value') ? [node.right] : [];
  }
  if (
    !isCallExpression(node) ||
    globalPathOf(unwrapped(node.expression))?.join('.') !== 'Object.assign'
  )
    return [];
  const prefix = framedArgumentPrefix(node);
  const [target] = prefix.values;
  if (target === undefined || !sameDescriptor(unwrapped(target), aliases)) return [];
  const values: Expression[] = [];
  for (const source of node.arguments.slice(1))
    values.push(...(framedDescriptorEntries(source, ['value']) ?? []));
  return values;
}
