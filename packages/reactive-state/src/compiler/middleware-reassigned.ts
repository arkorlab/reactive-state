import {
  type Identifier,
  isBinaryExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isVariableDeclarationList,
  type Node,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import type { ContextParameter, MiddlewareNames } from './middleware-reads.ts';

/**
 * A name of a route middleware's context that the middleware assigns before `next` — `slug =
 * slug.toLowerCase()` — is assigned in the guard, which runs on the authority, where the host's part
 * before `next` binds it as the context gave it and hands that to the part after `next`: a part the
 * host runs that reads the name reads the value the context gave it, not the value the source
 * assigned. A write through a member, `params.slug = …`, is no assignment of the name.
 */

/** The names a context binds. */
function contextNames(context: ContextParameter | undefined): ReadonlySet<string> {
  if (context === undefined) {
    return new Set();
  }
  return new Set(context.kind === 'whole' ? [context.name.text] : context.properties.keys());
}

/**
 * Each name `statements` assign, with the first place they do: by `=`, an operator's `=`, `++` or
 * `--`, a pattern's targets, or the head of a `for … in` or `for … of` that declares nothing. A
 * pattern's targets are read coarsely, every name within it.
 */
function assignedIn(statements: readonly Statement[]): ReadonlyMap<string, Identifier> {
  const assigned = new Map<string, Identifier>();
  const target = (node: Node): void => {
    if (isIdentifier(node)) {
      assigned.set(node.text, assigned.get(node.text) ?? node);
    } else if (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) {
      node.forEachChild(target);
    }
  };
  const visit = (node: Node): void => {
    if (isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment) {
        target(node.left);
      }
    } else if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) {
      if (
        node.operator === SyntaxKind.PlusPlusToken ||
        node.operator === SyntaxKind.MinusMinusToken
      ) {
        target(node.operand);
      }
    } else if (
      (isForOfStatement(node) || isForInStatement(node)) &&
      !isVariableDeclarationList(node.initializer)
    ) {
      target(node.initializer);
    }
    node.forEachChild(visit);
  };
  for (const statement of statements) {
    visit(statement);
  }
  return assigned;
}

/**
 * Refuses a name of the context that a statement before `next` (`before`) assigns and a part the
 * host runs (`hostReads`) reads: the guard holds the assigned value, the host's parts the one the
 * context gave.
 */
export function checkReassigned(
  before: readonly Statement[],
  hostReads: ReadonlySet<string>,
  names: MiddlewareNames,
): void {
  const bound = contextNames(names.context);
  for (const [name, place] of assignedIn(before)) {
    if (bound.has(name) && hostReads.has(name)) {
      names.fail(
        `\`${name}\` is a name of the route middleware's context, assigned before \`next\` and read by what the host runs: the assignment is written into the guard, which the authority runs, and the host's parts bind \`${name}\` as the context gave it, not as it was assigned. Give the assigned value a constant of its own, and read that where it is needed.`,
        place,
      );
    }
  }
}
