import {
  type ClassDeclaration,
  type ClassExpression,
  type Expression,
  isClassExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type VariableDeclaration,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { localClassBinding, localClassValueBinding } from './local-type-aliases.ts';
import { qualifiedClassBinding } from './local-type-class-namespaces.ts';

/** Written class bases followed through constant constructor aliases in their lexical value scope. */

interface ClassReference {
  readonly binding: ClassDeclaration | ClassExpression | null | undefined;
  readonly builtin: string | undefined;
}

/**
 * The source class or built-in constructor a heritage expression denotes, past plain constants and
 * through the namespaces a class is written in.
 */
export function heritageReference(expression: Expression): ClassReference {
  let value = unwrapped(expression);
  const seen = new Set<VariableDeclaration>();
  for (;;) {
    if (isClassExpression(value)) return { binding: value, builtin: undefined };
    const qualified = qualifiedClassBinding(value);
    if (qualified !== undefined) return { binding: qualified, builtin: undefined };
    if (!isIdentifier(value)) return { binding: null, builtin: heritageBuiltin(value) };
    const binding = localClassValueBinding(value);
    if (binding === undefined) return { binding, builtin: value.text };
    if (binding === null || !isVariableDeclaration(binding)) {
      return { binding, builtin: undefined };
    }
    if (seen.has(binding) || binding.initializer === undefined) {
      return { binding: null, builtin: undefined };
    }
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
}

const GLOBAL_OBJECTS = new Set(['global', 'globalThis', 'self', 'window']);

/** A class base's unshadowed global path, resolved where the expression actually runs. */
function heritageBuiltin(expression: Expression): string | undefined {
  const names: string[] = [];
  let each = expression;
  for (;;) {
    if (isPropertyAccessExpression(each)) {
      names.unshift(each.name.text);
      each = unwrapped(each.expression);
    } else if (isElementAccessExpression(each)) {
      const name = literalName(each);
      if (name === undefined) return undefined;
      names.unshift(name);
      each = unwrapped(each.expression);
    } else {
      break;
    }
  }
  if (!isIdentifier(each) || localClassBinding(each) !== undefined) return undefined;
  names.unshift(each.text);
  while (names.length > 1 && GLOBAL_OBJECTS.has(names[0] ?? '')) names.shift();
  return names.join('.');
}
