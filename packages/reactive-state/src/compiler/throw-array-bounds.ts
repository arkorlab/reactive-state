import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isNewExpression,
  isSourceFile,
  isSpreadElement,
  isVariableStatement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { calledMember } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { globalCalleePath } from './throw-callees.ts';
import { isTypedKind, primitiveOf, typedOf, wholeOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** Written native array lengths establish with indices and typed-array set copy bounds. */
export function arrayMethodBoundsThrow(
  callee: Expression,
  given: readonly Expression[],
  outer: Resolve | undefined,
): boolean {
  const member = calledMember(callee);
  const call = sourceCall(callee);
  if (member === undefined || call === undefined || !['set', 'with'].includes(member.name)) {
    return false;
  }
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const receiver = writtenOf(member.of, resolve);
  if (
    calleeUncertain(receiver, call) ||
    !quietValue(receiver, resolve) ||
    !quietCall(call, resolve)
  ) {
    return false;
  }
  if (member.name === 'with') {
    return (
      isArrayLiteralExpression(receiver) &&
      !receiver.elements.some((each) => isSpreadElement(each)) &&
      withIndexThrows(given[0], receiver.elements.length, resolve)
    );
  }
  const target = typedLength(receiver, resolve);
  if (target === undefined) {
    return false;
  }
  const offset = given[1] === undefined ? 0 : indexInteger(writtenOf(given[1], resolve), resolve);
  if (offset === undefined) {
    return false;
  }
  if (!Number.isFinite(offset) || offset < 0) {
    return true;
  }
  const source = given[0];
  const length = source === undefined ? undefined : sourceLength(source, call, resolve);
  return length !== undefined && offset + length > target;
}

/** A quiet source array counts holes too; a typed-array source contributes its native length. */
function sourceLength(
  node: Expression,
  call: CallExpression,
  resolve: Resolve,
): number | undefined {
  const value = writtenOf(node, resolve);
  if (calleeUncertain(value, call) || !quietValue(value, resolve)) {
    return undefined;
  }
  if (isArrayLiteralExpression(value)) {
    return value.elements.some((each) => isSpreadElement(each)) ? undefined : value.elements.length;
  }
  return typedLength(value, resolve);
}

/** The length of a concrete native typed construction, including constant constructor aliases. */
function typedLength(value: Expression, resolve: Resolve): number | undefined {
  if (!isNewExpression(value)) {
    return undefined;
  }
  const path = globalCalleePath(value.expression, resolve)?.join('.');
  return path === undefined ? undefined : typedOf(value, resolve, path)?.length;
}

/** All actual arguments finish before the native range check, including borrowed and extra arguments. */
function quietCall(call: CallExpression, resolve: Resolve): boolean {
  if (earlierExpressionEffect(call) || call.arguments.some((each) => !quietValue(each, resolve))) {
    return false;
  }
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some((statement) => {
        if (statement.end > each.pos) {
          return false;
        }
        return isVariableStatement(statement)
          ? statement.declarationList.declarations.some((declaration) => {
              return (
                declaration.initializer !== undefined &&
                !quietValue(declaration.initializer, resolve)
              );
            })
          : callbackCreationEffect(statement);
      })
    ) {
      return false;
    }
  }
  return true;
}

/** Known primitive typed construction is quiet; object coercion and other application work are not. */
function quietValue(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  if (!isNewExpression(value)) {
    return !callbackCreationEffect(value);
  }
  const path = globalCalleePath(value.expression, resolve)?.join('.') ?? '';
  if (!isTypedKind(path) || (value.arguments ?? []).some((each) => isSpreadElement(each))) {
    return false;
  }
  return (value.arguments ?? []).every((each) => {
    const source = writtenOf(each, resolve);
    const elements = isArrayLiteralExpression(source) ? source.elements : [source];
    return elements.every((element) => {
      const held = writtenOf(element, resolve);
      return !callbackCreationEffect(held) && primitiveOf(held, resolve) !== undefined;
    });
  });
}

/** Whether with selects no element: its integer index lies outside [-length, length), or is infinite. */
export function withIndexThrows(
  index: Expression | undefined,
  length: number | undefined,
  resolve: Resolve | undefined,
): boolean {
  const written = index === undefined ? undefined : writtenOf(index, resolve);
  if (
    written !== undefined &&
    (isBigIntWritten(written, resolve) || isSymbolWritten(written, resolve))
  ) {
    return true;
  }
  const at = written === undefined ? 0 : indexInteger(written, resolve);
  if (at === undefined) {
    return false;
  }
  return !Number.isFinite(at) || (length !== undefined && (at < -length || at >= length));
}

/** The integer a native index makes of a written primitive; unknown coercion remains runtime work. */
function indexInteger(value: Expression, resolve: Resolve | undefined): number | undefined {
  const written = constantValue(value, resolve);
  if (written !== undefined) {
    return wholeOf(written);
  }
  if (value.kind === SyntaxKind.TrueKeyword) {
    return 1;
  }
  return value.kind === SyntaxKind.FalseKeyword || primitiveOf(value, resolve) === 'nothing'
    ? 0
    : undefined;
}

/** Borrowed normalization keeps the original invocation among its callee's source ancestors. */
function sourceCall(node: Node): CallExpression | undefined {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (isCallExpression(each)) {
      return each;
    }
  }
  return undefined;
}
