import {
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type SpreadAssignment,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { executionOwner, repeatsAround } from './framed-array-mutations.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedDescriptorEntries } from './framed-descriptor-entries.ts';
import { framedArgumentPrefix, framedMemberNames } from './framed-keys.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
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
    const written =
      isBinaryExpression(at) || isCallExpression(at) ? writtenValues(at, aliases) : [];
    if (
      written.length > 0 &&
      (executionOwner(at) !== owner ||
        at.pos < node.pos ||
        destructuredFirst(at, node) ||
        repeatsBefore(at, node, aliases, owner)) &&
      framedPossibleBranch(at)
    )
      values.push(...written);
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return values;
}

/**
 * Whether a write after the read comes back to it: a loop around both passes again, or the function
 * that holds both is called again, with a descriptor made outside the repeated part as the last pass
 * left it. A descriptor made inside it is made anew each time, as `repeatedFrameRead` and
 * `repeatsAround` ask of each name that stands for it.
 */
function repeatsBefore(
  write: Node,
  read: Node,
  aliases: ReadonlySet<VariableDeclaration>,
  owner: Node,
): boolean {
  for (const alias of aliases)
    if (repeatedFrameRead(write, read, alias, owner) || repeatsAround(owner, alias)) return true;
  return false;
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
  const [target, ...sources] = framedArgumentPrefix(node, node.arguments, Infinity).values;
  if (target === undefined || !sameDescriptor(unwrapped(target), aliases)) return [];
  return sources.flatMap((source) => sourceValues(source));
}

/**
 * The values an `Object.assign` source may write under `value`: those of a literal, or of the
 * literal a whole constant alias chain ends in. Where a part of it cannot be read (a spread, a
 * computed name), the entries that may be named `value` stay possible values: that part adds
 * nothing and takes nothing away. A source that is no such literal writes nothing the walk knows.
 */
function sourceValues(source: Expression): readonly Expression[] {
  const literal = constantLiteral(source);
  if (literal === undefined) return [];
  return framedDescriptorEntries(literal, ['value']) ?? possibleValues(literal);
}

/** The object literal an expression is, or a whole constant alias chain of it ends in. */
function constantLiteral(expression: Expression): ObjectLiteralExpression | undefined {
  let value = unwrapped(expression);
  const seen = new Set<Node>();
  while (isIdentifier(value)) {
    const declared = frameDeclarationOf(value);
    if (declared === undefined || seen.has(declared) || !wholeConstant(declared)) return undefined;
    seen.add(declared);
    value = unwrapped(declared.initializer);
  }
  return isObjectLiteralExpression(value) ? value : undefined;
}

/**
 * Every data entry of a literal, and of the literals it spreads (each read once), whose name is
 * `value` or may be: a computed name the compile cannot read may name it. A spread it cannot read
 * is passed by.
 */
function possibleValues(literal: ObjectLiteralExpression): readonly Expression[] {
  const values: Expression[] = [];
  const seen = new Set([literal]);
  const pending = [literal];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    for (const property of at.properties) {
      if (isSpreadAssignment(property)) pending.push(...unseenLiteral(property.expression, seen));
      else values.push(...valueEntry(property));
    }
  }
  return values;
}

/** The literal a spread names, where it has not been read yet. */
function unseenLiteral(
  expression: Expression,
  seen: Set<ObjectLiteralExpression>,
): readonly ObjectLiteralExpression[] {
  const literal = constantLiteral(expression);
  if (literal === undefined || seen.has(literal)) return [];
  seen.add(literal);
  return [literal];
}

/** A data entry that is, or may be, named `value`: an accessor or a method holds no data. */
function valueEntry(
  property: Exclude<ObjectLiteralElementLike, SpreadAssignment>,
): readonly Expression[] {
  const name = writtenArrayKey(property.name);
  if (name !== undefined && name !== 'value') return [];
  if (isPropertyAssignment(property)) return [property.initializer];
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? [property.name]
    : [];
}
