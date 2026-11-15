import {
  type Expression,
  type Identifier,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import type { Resolve } from './numbers.ts';

/** Member reads that do not reach a container being written while its JSON contents are checked. */

interface Access {
  readonly root: Expression;
  readonly keys: readonly (string | undefined)[];
}

type Declared = (held: Expression) => VariableDeclaration | undefined;

/** The same holder through plain aliases declared in its own source, whose writes are followed together. */
export function aliasedDeclaration(
  held: Expression,
  follow: Resolve | undefined,
  declared: Declared,
): VariableDeclaration | undefined {
  let declaration = declared(held);
  const seen = new Set<VariableDeclaration>();
  while (
    declaration?.initializer !== undefined &&
    isIdentifier(unwrapped(declaration.initializer))
  ) {
    if (seen.has(declaration)) {
      break;
    }
    seen.add(declaration);
    const initializer = unwrapped(declaration.initializer);
    const next = isIdentifier(initializer) ? follow?.(initializer) : undefined;
    const other = next === undefined ? undefined : declared(next);
    if (other?.getSourceFile() !== declaration.getSourceFile()) {
      break;
    }
    declaration = other;
  }
  return declaration;
}

/** A plain constant alias followed as one read, without losing a member selection midway through it. */
export function followedAlias(
  name: Identifier,
  follow: Resolve | undefined,
  declared: Declared,
): Expression | undefined {
  const held = follow?.(name);
  return held !== undefined && isIdentifier(unwrapped(held))
    ? (aliasedDeclaration(held, follow, declared)?.initializer ?? held)
    : held;
}

/** A selected member and its actual constant holder, following plain aliases without revisiting one. */
function accessOf(node: Expression, follow: Resolve | undefined): Access | undefined {
  const keys: (string | undefined)[] = [];
  const seen = new Set<Expression>();
  let value = unwrapped(node);
  for (;;) {
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
      keys.unshift(
        isPropertyAccessExpression(value)
          ? value.name.text
          : literalKey(unwrapped(value.argumentExpression)),
      );
      value = unwrapped(value.expression);
      continue;
    }
    if (!isIdentifier(value)) {
      return { keys, root: value };
    }
    const held = follow?.(value);
    if (held === undefined) {
      return undefined;
    }
    value = unwrapped(held);
  }
}

/** Whether every written container is a known strict ancestor of this re-entrant member read. */
export function readsUntouchedMember(
  reference: Identifier,
  puts: readonly { readonly inside: Expression | undefined }[],
  follow: Resolve | undefined,
): boolean {
  let member: Expression = reference;
  for (;;) {
    const parent = member.parent;
    if (
      (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
      parent.expression === member
    ) {
      member = parent;
    } else {
      break;
    }
  }
  if (member === reference) {
    return false;
  }
  const read = accessOf(member, follow);
  if (read === undefined || read.keys.length === 0) {
    return false;
  }
  return puts.every(({ inside }) => {
    const written = inside === undefined ? undefined : accessOf(inside, follow);
    return (
      written?.root === read.root &&
      written.keys.length < read.keys.length &&
      written.keys.every((key, index) => key !== undefined && key === read.keys[index])
    );
  });
}
