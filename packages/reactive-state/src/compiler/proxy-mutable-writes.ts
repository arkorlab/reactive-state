import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { literalName } from './bounded.ts';
import { readsOf } from './local-module-reads.ts';
import { peelPlatform, platformPathsOf } from './platform-uses.ts';
import { isTypeOnly } from './scope.ts';

/** A value written into the container a `let` or `var` binding holds. */
export type WrittenMember =
  /** Stored at the member `name` of the container itself; `name` is undefined where computed. */
  | { readonly kind: 'member'; readonly name: string | undefined; readonly value: Expression }
  /** Stored deeper, in a member of a member, where any read of the container may reach it. */
  | { readonly kind: 'deep'; readonly value: Expression }
  /** Copied in whole, its members becoming the container's (`Object.assign(box, value)`). */
  | { readonly kind: 'merged'; readonly value: Expression };

/** Array methods whose arguments become elements of the receiver, from the argument at the number. */
const INSERTING_METHODS: ReadonlyMap<string, number> = new Map([
  ['fill', 0],
  ['push', 0],
  ['splice', 2],
  ['unshift', 0],
]);

/** Assignments that store their right side in their target. */
const STORING_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** What each declaration was found to have written into it, which the walk over the file need not repeat. */
const WRITTEN = new WeakMap<VariableDeclaration, readonly WrittenMember[]>();

/**
 * The values written into the container `declaration` holds, by a member assignment, an array method
 * or `Object.assign` anywhere in its file, wherever the write stands and whichever object the binding
 * then held: coarse, which only refuses more. A write through another name for the container is not
 * followed.
 */
export function writtenMembersOf(declaration: VariableDeclaration): readonly WrittenMember[] {
  const known = WRITTEN.get(declaration);
  if (known !== undefined) {
    return known;
  }
  const found = scanWrites(declaration);
  WRITTEN.set(declaration, found);
  return found;
}

/** Walks the file of `declaration` for the writes into its binding. */
function scanWrites(declaration: VariableDeclaration): readonly WrittenMember[] {
  if (!isIdentifier(declaration.name)) {
    return [];
  }
  const isRead = readsOf(declaration.name, declaration.getSourceFile());
  const found: WrittenMember[] = [];
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (isBinaryExpression(node) && STORING_ASSIGNMENTS.has(node.operatorToken.kind)) {
      const chain = memberChain(node.left, isRead);
      if (chain !== undefined && chain.length > 0) {
        found.push(chain.length === 1 ? member(chain[0], node.right) : deep(node.right));
      }
    } else if (isCallExpression(node)) {
      found.push(...callWrites(node, isRead));
    }
    node.forEachChild(visit);
  };
  declaration.getSourceFile().forEachChild(visit);

  return found;
}

/** A value stored at one member of the container. */
function member(name: string | undefined, value: Expression): WrittenMember {
  return { kind: 'member', name, value };
}

/** A value stored deeper in the container. */
function deep(value: Expression): WrittenMember {
  return { kind: 'deep', value };
}

/** What a call stores into the container: array insertions and the sources of `Object.assign`. */
function callWrites(
  call: CallExpression,
  isRead: (node: Node) => node is Identifier,
): WrittenMember[] {
  const callee = peelPlatform(call.expression);
  if (isPropertyAccessExpression(callee) && INSERTING_METHODS.has(callee.name.text)) {
    const chain = memberChain(callee.expression, isRead);
    const from = INSERTING_METHODS.get(callee.name.text) ?? 0;
    const values = call.arguments
      .slice(from)
      .map((each) => (isSpreadElement(each) ? each.expression : each));

    return chain === undefined
      ? []
      : values.map((value) => (chain.length === 0 ? member(undefined, value) : deep(value)));
  }
  const [target, ...sources] = call.arguments;
  if (
    target === undefined ||
    isSpreadElement(target) ||
    !platformPathsOf(call.expression).includes('Object.assign')
  ) {
    return [];
  }
  const chain = memberChain(target, isRead);
  if (chain === undefined) {
    return [];
  }
  const values = sources.map((each) => (isSpreadElement(each) ? each.expression : each));

  return values.map((value) => (chain.length === 0 ? { kind: 'merged', value } : deep(value)));
}

/**
 * The members `expr` reads from the container, outermost from the binding first, where `expr` is the
 * binding (none) or member reads of it; undefined where it is anything else. A name is undefined
 * where the member is computed.
 */
function memberChain(
  expr: Expression,
  isRead: (node: Node) => node is Identifier,
): readonly (string | undefined)[] | undefined {
  const names: (string | undefined)[] = [];
  let current = peelPlatform(expr);
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    names.unshift(isPropertyAccessExpression(current) ? current.name.text : literalName(current));
    current = peelPlatform(current.expression);
  }
  return isIdentifier(current) && isRead(current) ? names : undefined;
}
