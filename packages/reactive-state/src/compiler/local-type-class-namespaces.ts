import {
  type ClassDeclaration,
  type Expression,
  isClassDeclaration,
  isIdentifier,
  isPropertyAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { localNamespaceValue } from './local-type-aliases.ts';
import { namespaceMemberBinding } from './local-type-namespaces.ts';

/** A class base written through namespaces is followed to its declaration where the code shows it. */

/**
 * The class `NS.Base` of a heritage expression names, through the namespaces declared around it: the
 * class, `null` where the name is a value the code does not show (a constant, a parameter or an
 * import called `NS`, a member the namespaces do not export, a member that is not a class), and
 * `undefined` where it is no path of a local value, so that a global's path is read as it was.
 */
export function qualifiedClassBinding(expression: Expression): ClassDeclaration | null | undefined {
  const members: string[] = [];
  let root = unwrapped(expression);
  if (!isPropertyAccessExpression(root)) return undefined;
  while (isPropertyAccessExpression(root)) {
    members.unshift(root.name.text);
    root = unwrapped(root.expression);
  }
  if (!isIdentifier(root)) return undefined;
  const namespaces = localNamespaceValue(root);
  if (namespaces === undefined) return undefined;
  if (namespaces === null) return null;
  const member = namespaceMemberBinding(namespaces, members);
  return member !== undefined && member !== null && isClassDeclaration(member) ? member : null;
}
