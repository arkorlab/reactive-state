import {
  type Expression,
  type Identifier,
  isAsExpression,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isTypeAssertion,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { readsOf } from './local-module-reads.ts';
import { bindingIdentifiers } from './scope.ts';
import { freshReceiverDefault, receiverKey } from './this-defaults.ts';

/** Constant aliases of this, including retained members selected by a binding pattern. */
interface Alias {
  readonly name: Identifier;
  readonly value: Expression;
  readonly projected: boolean;
  readonly reads: (node: Node) => node is Identifier;
}

const ALIASES = new WeakMap<SourceFile, readonly Alias[]>();

/** A write through an alias changes its referent; assigning the local binding changes no receiver. */
export function receiverWrite(target: Node, operation: Node): boolean {
  if (isIdentifier(target) && !isCallExpression(operation)) {
    return false;
  }
  const receiver =
    !isCallExpression(operation) &&
    (isPropertyAccessExpression(target) || isElementAccessExpression(target))
      ? target.expression
      : target;
  return receiverOf(receiver);
}

/** Whether a value retains this or one of its members; whole excludes member projections. */
export function receiverOf(node: Node, whole = false): boolean {
  const seen = new Set<Node>();
  const path: (string | undefined)[] = [];
  let value = node;
  while (!seen.has(value)) {
    seen.add(value);
    if (value.kind === SyntaxKind.ThisKeyword) {
      return true;
    }
    if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
      if (whole) {
        return false;
      }
      path.unshift(receiverKey(value));
      value = value.expression;
      continue;
    }
    if (wrapped(value)) {
      value = value.expression;
      continue;
    }
    if (!isIdentifier(value)) {
      return false;
    }
    const held = aliasValue(value, path, whole);
    if (held === undefined) {
      return false;
    }
    value = held;
  }
  return false;
}

/** A lexical alias excluding a chosen fresh default and projections of another receiver. */
function aliasValue(
  name: Identifier,
  path: readonly (string | undefined)[],
  whole: boolean,
): Expression | undefined {
  const alias = aliasesOf(name.getSourceFile()).find(
    (each) => each.name.text === name.text && each.reads(name),
  );
  if (alias === undefined || (whole && alias.projected)) {
    return undefined;
  }
  return alias.projected && freshReceiverDefault(alias.name, alias.value, path)
    ? undefined
    : alias.value;
}

/** Wrappers preserving the same object reference. */
function wrapped(node: Node): node is Node & { readonly expression: Expression } {
  return (
    isParenthesizedExpression(node) ||
    isNonNullExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isTypeAssertion(node)
  );
}

/** Source constants and their lexical reads, computed once for each source tree. */
function aliasesOf(file: SourceFile): readonly Alias[] {
  const cached = ALIASES.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const aliases: Alias[] = [];
  const visit = (node: Node): void => {
    if (
      isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      /^const\s/u.test(node.parent.getText(file))
    ) {
      for (const name of bindingIdentifiers(node.name)) {
        if (!restBinding(name, node.name)) {
          aliases.push({
            name,
            value: node.initializer,
            projected: !isIdentifier(node.name),
            reads: readsOf(name, file),
          });
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  ALIASES.set(file, aliases);
  return aliases;
}

/** Rest patterns allocate a fresh container instead of retaining the receiver itself. */
function restBinding(name: Identifier, pattern: Node): boolean {
  for (let at: Node = name; at !== pattern; at = at.parent) {
    if (isBindingElement(at) && at.dotDotDotToken !== undefined) {
      return true;
    }
  }
  return false;
}
