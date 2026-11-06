import { isIdentifier, isQualifiedName, type TypeQueryNode } from 'typescript/ast';

import { localClassValueBinding } from './local-type-aliases.ts';

/** Native error prototype type queries resolved through their lexical constructor value. */

const ERROR_PROTOTYPES = new Set([
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

/** A native error prototype's instance type, with locally declared values kept opaque. */
export function prototypeQueryBuiltin(type: TypeQueryNode): string | undefined {
  const member = type.exprName;
  if (!isQualifiedName(member) || member.right.text !== 'prototype') return undefined;
  const constructor = member.left;
  if (isIdentifier(constructor)) {
    return ERROR_PROTOTYPES.has(constructor.text) &&
      localClassValueBinding(constructor) === undefined
      ? constructor.text
      : undefined;
  }
  const name = constructor.right.text;
  if (!ERROR_PROTOTYPES.has(name)) return undefined;
  let root = constructor.left;
  while (isQualifiedName(root)) {
    if (root.right.text !== 'globalThis') return undefined;
    root = root.left;
  }
  return root.text === 'globalThis' && localClassValueBinding(root) === undefined
    ? name
    : undefined;
}
