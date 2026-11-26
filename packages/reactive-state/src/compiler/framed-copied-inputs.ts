/**
 * What a native `Array.from` copies from a source no array reader reads may be an Error where its
 * declared element type admits one, as `framedMemberAdmitted` reads it at the read keys.
 */

import { isIdentifier, isParameterDeclaration, SyntaxKind } from 'typescript/ast';

import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedMemberAdmitted } from './framed-error-admission.ts';

/** Sources an array reader reads where no copy reader expands them: names, member reads, text. */
const READ: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.Identifier,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateExpression,
]);

/**
 * Whether a reading of what a native `Array.from` copies (`copiedFrom`) has reached a source no
 * array reader reads, whose declared element type admits an Error at the keys read past the
 * copied element: a parameter, which holds what a caller gives; a call or a construction no copy
 * reader expands; or anything but a written array, a name, a member read or text — a comma that
 * may run code first among them.
 */
export function framedCopiedUnread(reading: ArrayElementView): boolean {
  const { copiedFrom, value } = reading;
  if (copiedFrom === undefined) return false;
  const binding = isIdentifier(value) ? frameBindingOf(value)?.binding : undefined;
  const unread = binding === undefined ? !READ.has(value.kind) : isParameterDeclaration(binding);
  const keys = (reading.keys ?? []).slice(copiedFrom.depth);
  return unread && framedMemberAdmitted(copiedFrom.call.typeArguments?.[0], keys);
}
