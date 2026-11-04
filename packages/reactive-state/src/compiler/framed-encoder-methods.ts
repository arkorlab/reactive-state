import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBlock,
  isElementAccessExpression,
  isExpression,
  isExpressionStatement,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Native encoder identity and a closed immediately preceding own-method replacement. */

const ENCODER = new Set(['TextEncoder']);

/** Whole immutable aliases retain the exact source-known native construction and its brand. */
export function framedEncoderSource(node: Expression): Expression | undefined {
  let value = unwrapped(node);
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
  return isNewExpression(value) && framedNativeConstructor(value.expression, ENCODER)
    ? value
    : undefined;
}

/** A direct own callable replaces native conversion only before an otherwise effect-free read. */
export function framedOwnEncoderMethod(call: CallExpression): boolean {
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return false;
  const source = framedEncoderSource(member.expression);
  const statement = closedReadStatement(call);
  if (source === undefined || statement === undefined || !isBlock(statement.parent)) return false;
  const statements = statement.parent.statements;
  const index = statements.indexOf(statement);
  if (index <= 0) return false;
  const previous = statements[index - 1];
  if (previous === undefined || !isExpressionStatement(previous)) return false;
  const assignment = unwrapped(previous.expression);
  if (!isBinaryExpression(assignment) || assignment.operatorToken.kind !== SyntaxKind.EqualsToken)
    return false;
  const target = unwrapped(assignment.left);
  return (
    (isPropertyAccessExpression(target) || isElementAccessExpression(target)) &&
    frameMemberName(target) === frameMemberName(member) &&
    framedEncoderSource(target.expression) === source &&
    sourceArrayFunction(assignment.right) &&
    unexposedEncoder(source, assignment, call)
  );
}

/** The return or expression statement reads this call before any other application work. */
function closedReadStatement(call: CallExpression): Statement | undefined {
  let node: Node = call;
  for (;;) {
    const { at, parent } = useOf(node);
    if (!isExpression(at)) return undefined;
    if (
      (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
      parent.expression === at
    ) {
      node = parent;
      continue;
    }
    return (isReturnStatement(parent) || isExpressionStatement(parent)) && parent.expression === at
      ? parent
      : undefined;
  }
}

/** An assignment can establish an own data method only while its native instance is unexposed. */
function unexposedEncoder(source: Expression, assignment: Node, call: CallExpression): boolean {
  const owner = executionOwner(call);
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && exposesEncoder(node, { source, assignment, owner })) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Same-origin earlier reads or any other execution owner can install an intercepting accessor. */
function exposesEncoder(
  name: Identifier,
  context: { readonly source: Expression; readonly assignment: Node; readonly owner: Node },
): boolean {
  if (!readsBinding(name)) return false;
  const selected = frameBindingOf(name);
  if (
    selected === undefined ||
    name === selected.binding.name ||
    framedEncoderSource(name) !== context.source
  )
    return false;
  if (executionOwner(name) !== context.owner) return true;
  if (name.pos >= context.assignment.pos) return false;
  const { parent } = useOf(name);
  return !(
    isVariableDeclaration(parent) &&
    isIdentifier(parent.name) &&
    parent.initializer !== undefined &&
    unwrapped(parent.initializer) === name &&
    framedEncoderSource(parent.name) === context.source
  );
}
