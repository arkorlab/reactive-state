import {
  type Expression,
  isBlock,
  isCallExpression,
  isConstructorDeclaration,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isSourceFile,
  isSpreadElement,
  isStringLiteral,
  type Node,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { calledMember, unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { metadataParameters } from './input-bindings.ts';
import { metadataCallee, metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { callbackResultThrows } from './throw-callback-results.ts';
import { writtenOf } from './throw-shapes.ts';

/** A replacement callback invoked by a source-written matching text pattern. */
export function replacementFunction(node: Node, resolve: Resolve | undefined): Node | undefined {
  if (
    !isCallExpression(node) ||
    node.arguments.length !== 2 ||
    node.arguments.some((each) => isSpreadElement(each)) ||
    earlierEffect(node) ||
    earlierExpressionEffect(node)
  ) {
    return undefined;
  }
  const member = calledMember(unwrapped(node.expression));
  if (member === undefined || !['replace', 'replaceAll'].includes(member.name)) {
    return undefined;
  }
  const [pattern, callback] = node.arguments;
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const receiver = writtenOf(member.of, follow);
  const search = pattern === undefined ? undefined : writtenOf(pattern, follow);
  if (
    callback === undefined ||
    search === undefined ||
    !textLiteral(receiver) ||
    !textLiteral(search) ||
    !receiver.text.includes(search.text)
  ) {
    return undefined;
  }
  const fn = metadataCallee(writtenOf(callback, follow));
  return fn !== undefined && isAnswering(fn) && ordinaryParameters(fn) ? fn : undefined;
}

/** A necessarily invoked replacement result that the native operation cannot convert to text. */
export function replacementResultThrows(node: Node, resolve: Resolve | undefined): boolean {
  const fn = replacementFunction(node, resolve);
  return fn !== undefined && isAnswering(fn) && callbackResultThrows(fn, 'string', resolve);
}

/** Text alone establishes a match without running a RegExp or an application conversion. */
function textLiteral(node: Node): node is Expression & { readonly text: string } {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node);
}

/** Text replacement supplies match, offset and full text; later defaults can run application code. */
function ordinaryParameters(fn: Answering): boolean {
  const given = ['match', 'offset', 'text'];
  return metadataParameters(fn).every(
    (parameter, index) =>
      isIdentifier(parameter.name) && (parameter.initializer === undefined || index < given.length),
  );
}

/** Prior application work can change the native method or the replacement's known operations. */
function earlierEffect(node: Node): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (
      isBlock(each.parent) &&
      each.parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return true;
    }
    if (isAnswering(each.parent) || isConstructorDeclaration(each.parent)) {
      break;
    }
  }
  return false;
}
