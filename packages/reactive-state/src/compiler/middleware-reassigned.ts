import {
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isForInStatement,
  isExpression,
  isForOfStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclarationList,
  type Node,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
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
 * What a target of an assignment assigns through, where it is a pattern: an array's elements, an
 * object's members, a member's value side — not its key, nor a computed one — a spread's expression,
 * and the left of a default, never its expression. A name is a target itself; a member, `params.slug`,
 * writes the member, and a call or an operation is none.
 */
function partsOf(target: Node): readonly Node[] {
  if (isArrayLiteralExpression(target)) return target.elements;
  if (isObjectLiteralExpression(target)) return target.properties;
  if (isShorthandPropertyAssignment(target)) return [target.name];
  if (isPropertyAssignment(target)) return [target.initializer];
  if (isSpreadElement(target) || isSpreadAssignment(target)) return [target.expression];
  const isDefault =
    isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken;
  return isDefault ? [target.left] : [];
}

/**
 * Each name `statements` assign, with the first place they do: by `=`, an operator's `=`, `++` or
 * `--`, the targets of a pattern (`partsOf`), or the head of a `for … in` or `for … of` that
 * declares nothing.
 */
function assignedIn(statements: readonly Statement[]): ReadonlyMap<string, Identifier> {
  const assigned = new Map<string, Identifier>();
  const target = (node: Node): void => {
    const written = isExpression(node) ? unwrapped(node) : node;
    if (isIdentifier(written)) {
      assigned.set(written.text, assigned.get(written.text) ?? written);
    } else {
      for (const part of partsOf(written)) {
        target(part);
      }
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

/** Where the statements before `next` go: the guard's, the host's, and what the host's parts read. */
interface Sides {
  readonly guard: readonly Statement[];
  readonly host: readonly Statement[];
  readonly hostReads: ReadonlySet<string>;
}

/**
 * Refuses a name of the context that is assigned before `next` where one part cannot see the other's
 * assignment: in a statement the guard takes, where a part the host runs reads it — the guard holds
 * the assigned value, the host's parts the one the context gave — and in a statement the host runs
 * before `next`, which the guard reads as the context gave it, and where the middleware declares its
 * context's type the host's part binds the names by a `const`, which an assignment would throw at.
 */
export function checkReassigned(sides: Sides, names: MiddlewareNames): void {
  const bound = contextNames(names.context);
  for (const [name, place] of assignedIn(sides.guard)) {
    if (bound.has(name) && sides.hostReads.has(name)) {
      names.fail(
        `\`${name}\` is a name of the route middleware's context, assigned before \`next\` and read by what the host runs: the assignment is written into the guard, which the authority runs, and the host's parts bind \`${name}\` as the context gave it, not as it was assigned. Give the assigned value a constant of its own, and read that where it is needed.`,
        place,
      );
    }
  }
  for (const [name, place] of assignedIn(sides.host)) {
    if (bound.has(name)) {
      names.fail(
        `\`${name}\` is a name of the route middleware's context, assigned before \`next\` by what the host runs: the guard, which the authority runs, binds \`${name}\` as the context gave it, and where the middleware declares its context's type the host's part binds it by a \`const\`, which the assignment would throw at. Give the assigned value a constant of its own, and read that where it is needed.`,
        place,
      );
    }
  }
}
