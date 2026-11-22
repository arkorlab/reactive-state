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
import { prependBindingPath } from './this-rest-defaults.ts';

/** Constant aliases of this, including retained members selected by a binding pattern. */
interface Alias {
  readonly name: Identifier;
  readonly value: Expression;
  readonly projected: boolean;
  readonly rest: boolean;
  readonly reads: (node: Node) => node is Identifier;
}

/** Mutable walk state tracking member selections along a candidate receiver reference. */
interface WalkState {
  readonly path: (string | undefined)[];
  selected: boolean;
  readonly whole: boolean;
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
  const state: WalkState = { path: [], selected: false, whole };
  let value = node;
  while (!seen.has(value)) {
    seen.add(value);
    if (value.kind === SyntaxKind.ThisKeyword) {
      return true;
    }
    const next = nextValue(value, state);
    if (next === undefined) {
      return false;
    }
    value = next;
  }
  return false;
}

/** Advances one step backward from `value` toward its underlying receiver expression. */
function nextValue(value: Node, state: WalkState): Node | undefined {
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (state.whole) {
      return undefined;
    }
    state.path.unshift(receiverKey(value));
    state.selected = true;
    return value.expression;
  }
  if (wrapped(value)) {
    return value.expression;
  }
  return isIdentifier(value) ? aliasValue(value, state) : undefined;
}

/** A lexical alias excluding a fresh rest container itself, fresh defaults, and member projections when `whole`. */
function aliasValue(name: Identifier, state: WalkState): Expression | undefined {
  const alias = aliasesOf(name.getSourceFile()).find(
    (each) => each.name.text === name.text && each.reads(name),
  );
  if (
    alias === undefined ||
    (state.whole && alias.projected) ||
    (alias.rest && !state.selected) ||
    (alias.projected && freshReceiverDefault(alias.name, alias.value, state.path))
  ) {
    return undefined;
  }
  if (alias.projected) {
    prependBindingPath(alias.name, state.path);
    state.selected = true;
  }
  return alias.value;
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
        aliases.push({
          name,
          value: node.initializer,
          projected: !isIdentifier(node.name),
          rest: isRestContainer(name),
          reads: readsOf(name, file),
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  ALIASES.set(file, aliases);
  return aliases;
}

/** Whether `name` itself binds the fresh shallow container allocated by a rest element. */
function isRestContainer(name: Identifier): boolean {
  return isBindingElement(name.parent) && name.parent.dotDotDotToken !== undefined;
}
