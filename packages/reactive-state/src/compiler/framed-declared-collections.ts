/**
 * What a native collection is declared to hold: its construction's own type arguments, else what
 * the annotation of a name it is read through gives, as TypeScript's checker reads it (a reference
 * to the global Map or Set type of the collection's kind, past aliases and generics), and whether a
 * value at a member path of it may be an Error (`framedAdmittedAt`).
 */

import type { TypeNode } from 'typescript/ast';
import type { TypeReference } from 'typescript/sync';

import { framedAdmittedAt, framedMemberAdmitted } from './framed-error-admission.ts';
import { type CheckedNode, framedChecked } from './type-checker.ts';

/** What a collection is declared as: its construction's own type arguments, else an annotation. */
export interface DeclaredCollection {
  /** The construction's own type arguments, `new Set<T>()`, as written. */
  readonly written: readonly TypeNode[] | undefined;
  /** The annotation of a name the collection is read through. */
  readonly annotation: TypeNode | undefined;
}

/**
 * Whether a collection's declared type admits an Error at an argument and at the read keys within
 * it: its construction's own argument where written (`framedMemberAdmitted`), else the argument of
 * the global collection type its annotation names (`nativeReference`). An annotation of any other
 * type, or one the checker cannot read, admits one, as none declared does.
 */
export function framedDeclaredAdmitted(
  declared: DeclaredCollection,
  kind: 'Map' | 'Set',
  index: number,
  keys: readonly string[] = [],
): boolean {
  if (declared.written !== undefined) return framedMemberAdmitted(declared.written[index], keys);
  const { annotation } = declared;
  const checked = annotation === undefined ? undefined : framedChecked(annotation);
  const reference = checked === undefined ? undefined : nativeReference(checked, kind);
  if (checked === undefined || reference === undefined) return true;
  const argument = checked.checker.getTypeArguments(reference)[index];
  return argument === undefined || framedAdmittedAt(checked, argument, keys);
}

/** Whether a collection declares a type the checker reads as its kind's (`framedDeclaredAdmitted`). */
export function framedCollectionDeclared(
  declared: DeclaredCollection,
  kind: 'Map' | 'Set',
): boolean {
  if (declared.written !== undefined) return true;
  const { annotation } = declared;
  const checked = annotation === undefined ? undefined : framedChecked(annotation);
  return checked !== undefined && nativeReference(checked, kind) !== undefined;
}

/** The reference to a global collection type of the kind an annotation's type is, if it is one. */
function nativeReference(checked: CheckedNode, kind: 'Map' | 'Set'): TypeReference | undefined {
  const type = checked.checker.getTypeFromTypeNode(checked.node as TypeNode);
  return type.isTypeReference() && checked.globals.natives[kind].has(type.getTarget().id)
    ? type
    : undefined;
}
