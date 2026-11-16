import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBlock,
  isElementAccessExpression,
  isExpressionStatement,
  isExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName, frameTypeOf } from './framed-bindings.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { namesLocalMemberType } from './local-type-reading.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Known native pattern receivers and closed source-written own methods. */

const PATTERN = new Set(['RegExp']);

/** Literal patterns, native constructions and written native instance types retain pattern identity. */
export function framedRegExpReceiver(expression: Expression): boolean {
  if (patternSource(expression) !== undefined) return true;
  const selected = frameTypeOf(expression);
  return selected !== undefined && namesLocalMemberType(selected.type, selected.keys, PATTERN);
}

/** A directly preceding own callable on an unexposed local pattern replaces the native method. */
export function framedOwnRegExpMethod(call: CallExpression): boolean {
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return false;
  const method = frameMemberName(member);
  const source = patternSource(member.expression);
  const { at, parent } = useOf(call);
  if (
    method === undefined ||
    source === undefined ||
    !isExpression(at) ||
    (!isReturnStatement(parent) && !isExpressionStatement(parent)) ||
    parent.expression !== at ||
    !isBlock(parent.parent)
  )
    return false;
  const statements = parent.parent.statements;
  const previous = statements[statements.indexOf(parent) - 1];
  if (previous === undefined || !isExpressionStatement(previous)) return false;
  const assignment = unwrapped(previous.expression);
  if (!isBinaryExpression(assignment) || assignment.operatorToken.kind !== SyntaxKind.EqualsToken)
    return false;
  const target = unwrapped(assignment.left);
  return (
    (isPropertyAccessExpression(target) || isElementAccessExpression(target)) &&
    frameMemberName(target) === method &&
    patternSource(target.expression) === source &&
    sourceArrayFunction(assignment.right) &&
    unexposedPattern(source, assignment, call)
  );
}

/** Whole immutable receiver aliases retain their native literal or construction. */
function patternSource(expression: Expression): Expression | undefined {
  let value = unwrapped(expression);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) return undefined;
    const { binding } = selected;
    if (!isVariableDeclaration(binding) || binding.initializer === undefined) return undefined;
    const statement = binding.parent.parent;
    if (
      !isVariableStatement(statement) ||
      !/^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    )
      return undefined;
    value = unwrapped(binding.initializer);
  }
  return value.kind === SyntaxKind.RegularExpressionLiteral ||
    (isNewExpression(value) && framedNativeConstructor(value.expression, PATTERN))
    ? value
    : undefined;
}

/** Earlier reads and references in other execution owners invalidate a closed own-method proof. */
function unexposedPattern(source: Expression, assignment: Node, call: CallExpression): boolean {
  const owner = executionOwner(call);
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && patternExposed(node, { source, assignment, owner })) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Earlier nonalias reads or other execution owners can expose the native pattern. */
function patternExposed(
  name: Identifier,
  context: { readonly source: Expression; readonly assignment: Node; readonly owner: Node },
): boolean {
  if (!readsBinding(name) || patternSource(name) !== context.source) return false;
  const selected = frameBindingOf(name);
  if (selected === undefined || name === selected.binding.name) return false;
  if (executionOwner(name) !== context.owner) return true;
  return name.pos < context.assignment.pos && !patternAliasInitializer(name, context.source);
}

/** A whole const alias keeps this same native receiver without handing it to application code. */
function patternAliasInitializer(name: Identifier, source: Expression): boolean {
  const { parent } = useOf(name);
  return (
    isVariableDeclaration(parent) &&
    isIdentifier(parent.name) &&
    parent.initializer !== undefined &&
    unwrapped(parent.initializer) === name &&
    patternSource(parent.name) === source
  );
}
