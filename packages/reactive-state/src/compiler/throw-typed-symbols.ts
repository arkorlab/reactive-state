import {
  type Expression,
  isBlock,
  isCallExpression,
  isNewExpression,
  isSourceFile,
  type Node,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { calledMember } from './bounded.ts';
import { callbackCreationEffect } from './callback-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { isTypedKind, primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** An unchanged native symbol creation or well-known symbol cannot become a typed element. */
export function typedSymbolElement(node: Expression, outer: Resolve | undefined): boolean {
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const value = writtenOf(node, resolve);
  if (!isSymbolWritten(value, resolve) || !quietBefore(value, resolve)) {
    return false;
  }
  return (
    !isCallExpression(value) || value.arguments.every((argument) => quietScalar(argument, resolve))
  );
}

/** Native callee reads do not invoke application code before creating the converted symbol. */
function quietBefore(value: Expression, resolve: Resolve): boolean {
  for (let each: Node = value; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (isBlock(parent)) {
      if (
        parent.statements.some(
          (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
        )
      ) {
        return false;
      }
    } else if (!isAnswering(parent)) {
      const effect = parent.forEachChild((part) => {
        return part.end <= each.pos && callbackCreationEffect(part) && !nativePrefix(part, resolve)
          ? true
          : undefined;
      });
      if (effect === true) {
        return false;
      }
    }
  }
  return true;
}

/** Only the known typed native accesses preceding an element's creation are quiet. */
function nativePrefix(node: Node, resolve: Resolve): boolean {
  const value = node as Expression;
  const path = globalCalleePath(value, resolve);
  if (
    path !== undefined &&
    isTypedKind(path[0] ?? '') &&
    (path.length === 1 || path[1] === 'of' || path[1] === 'from')
  ) {
    return true;
  }
  if (typedCreation(value, resolve)) {
    return true;
  }
  const member = calledMember(value);
  return (
    member !== undefined &&
    ['fill', 'set', 'with'].includes(member.name) &&
    typedCreation(member.of, resolve)
  );
}

/** A native typed array constructed from quiet primitive sizes executes no application callback. */
function typedCreation(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  return (
    isNewExpression(value) &&
    isTypedKind(globalCalleePath(value.expression, resolve)?.join('.') ?? '') &&
    (value.arguments ?? []).every((argument) => quietScalar(argument, resolve))
  );
}

function quietScalar(node: Expression, resolve: Resolve): boolean {
  return primitiveOf(node, resolve) !== undefined && !callbackCreationEffect(node);
}
