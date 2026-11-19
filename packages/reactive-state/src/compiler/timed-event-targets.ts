import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { patternKey } from './code-globals.ts';
import { peelPlatform } from './platform-uses.ts';
import type { BindingWriteContext } from './timed-event-bindings.ts';

/** Projects `right` down to each destructured write site targeting `ctx.isRead`. */
export function pushDestructuringWriteQueries(
  pattern: Expression,
  right: Expression,
  ctx: BindingWriteContext,
): void {
  const { isRead, keys, path, pending } = ctx;
  const clean = peelPlatform(pattern);
  if (isIdentifier(clean) && isRead(clean)) {
    pending.push({ expr: right, keys: [...path, ...keys] });
    return;
  }
  if (isBinaryExpression(clean) && clean.operatorToken.kind === SyntaxKind.EqualsToken) {
    pushDestructuringWriteQueries(clean.left, right, ctx);
    // The default is the element's own value, with none of the path to the element.
    pushDestructuringWriteQueries(clean.left, clean.right, { ...ctx, path: [] });
    return;
  }
  if (isObjectLiteralExpression(clean)) {
    pushObjectDestructuringWrite(clean, right, ctx);
  } else if (isArrayLiteralExpression(clean)) {
    pushArrayDestructuringWrite(clean, right, ctx);
  }
}

/** Projects `right` through an array assignment pattern toward `ctx.isRead`, a rest element apart. */
function pushArrayDestructuringWrite(
  clean: ArrayLiteralExpression,
  right: Expression,
  ctx: BindingWriteContext,
): void {
  for (const [index, el] of clean.elements.entries()) {
    const rest = isSpreadElement(el);
    pushDestructuringWriteQueries(rest ? el.expression : el, right, {
      ...ctx,
      keys: rest ? restElementKeys(ctx.keys) : ctx.keys,
      path: rest ? ctx.path : [...ctx.path, String(index)],
    });
  }
}

/** Computes element projection keys through an array rest target. */
function restElementKeys(keys: readonly (string | null)[]): readonly (string | null)[] {
  return keys.length > 0 ? [null, ...keys.slice(1)] : [];
}

/** Projects `right` through an object assignment pattern toward `ctx.isRead`. */
function pushObjectDestructuringWrite(
  clean: Expression & { readonly properties: readonly Node[] },
  right: Expression,
  ctx: BindingWriteContext,
): void {
  const { isRead, keys, path, pending } = ctx;
  for (const prop of clean.properties) {
    if (isShorthandPropertyAssignment(prop) && isRead(prop.name)) {
      pending.push({ expr: right, keys: [...path, prop.name.text, ...keys] });
      if (prop.objectAssignmentInitializer !== undefined) {
        pending.push({ expr: prop.objectAssignmentInitializer, keys });
      }
    } else if (isPropertyAssignment(prop)) {
      pushDestructuringWriteQueries(prop.initializer, right, {
        ...ctx,
        path: [...path, patternKey(prop) ?? null],
      });
    } else if (isSpreadAssignment(prop)) {
      pushDestructuringWriteQueries(prop.expression, right, ctx);
    }
  }
}
