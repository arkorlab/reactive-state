import {
  type Expression,
  type Identifier,
  type PropertyName,
  type VariableDeclaration,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isComputedPropertyName,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** A fresh unexposed native formatter can retain one unconditional primitive-returning own method. */

type LiteralResult = (value: Expression) => boolean;

interface LiteralOverride {
  readonly block: Node;
  readonly name: string | undefined;
  readonly literal: LiteralResult;
}

/** One unexposed constant instance can keep an unconditional literal-returning own method. */
export function literalIntlOwnMethod(
  node: Expression,
  names: readonly string[] | undefined,
  native: (callee: Expression) => boolean,
  literal: LiteralResult = literalValue,
): boolean {
  if (!isIdentifier(node) || names?.length !== 1) return false;
  const selected = frameBindingOf(node);
  if (selected === undefined || selected.keys.length > 0) return false;
  const { binding } = selected;
  if (
    !isVariableDeclaration(binding) ||
    !isVariableDeclarationList(binding.parent) ||
    !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
    binding.initializer === undefined
  )
    return false;
  const made = unwrapped(binding.initializer);
  if (!isNewExpression(made) || !native(made.expression)) return false;
  if (executionOwner(node) !== executionOwner(binding)) return false;
  const statement = binding.parent.parent;
  if (!isVariableStatement(statement)) return false;
  return singleLiteralOverride(node, binding, { block: statement.parent, name: names[0], literal });
}

/** Every other reference is the one literal override; no hidden alias or closure can change it. */
function singleLiteralOverride(
  node: Identifier,
  binding: VariableDeclaration,
  override: LiteralOverride,
): boolean {
  let overrides = 0;
  const pending: Node[] = [binding.getSourceFile()];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeOnly(at)) continue;
    if (
      at !== node &&
      at !== binding.name &&
      isIdentifier(at) &&
      at.text === node.text &&
      readsBinding(at) &&
      frameDeclarationOf(at) === binding
    ) {
      if (!literalOverride(at, node, override)) return false;
      overrides += 1;
    }
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return overrides === 1;
}

/** The only other instance use writes that literal method in the same unconditional prefix. */
function literalOverride(
  node: Identifier,
  read: Identifier,
  { name, block, literal }: LiteralOverride,
): boolean {
  const { at: receiver, parent: member } = useOf(node);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    member.expression !== receiver ||
    frameMemberName(member) !== name
  )
    return false;
  const { at, parent } = useOf(member);
  return (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === at &&
    parent.pos < read.pos &&
    isExpressionStatement(parent.parent) &&
    parent.parent.parent === block &&
    literalFunction(parent.right, literal)
  );
}

/** A zero-argument written function returning only primitive literal syntax has no environment read. */
function literalFunction(node: Expression, literal: LiteralResult): boolean {
  const value = unwrapped(node);
  if (!isArrowFunction(value) && !isFunctionExpression(value)) return false;
  if (value.parameters.length > 0) return false;
  if (isFunctionExpression(value) && value.asteriskToken !== undefined) return false;
  if (value.modifiers?.some((each) => each.kind === SyntaxKind.AsyncKeyword) === true) return false;
  const body = value.body;
  if (!isBlock(body)) return literal(body);
  const [statement] = body.statements;
  return (
    body.statements.length === 1 &&
    statement !== undefined &&
    isReturnStatement(statement) &&
    statement.expression !== undefined &&
    literal(statement.expression)
  );
}

/** Newly tracked native families retain primitive and flat literal own result dictionaries. */
export function literalIntlData(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    literalValue(value) ||
    (isObjectLiteralExpression(value) &&
      value.properties.every((property) => {
        return (
          isPropertyAssignment(property) &&
          literalDataName(property.name) &&
          literalValue(property.initializer)
        );
      }))
  );
}

/** Written dictionary keys add no getter, spread or application conversion. */
function literalDataName(name: PropertyName): boolean {
  return (
    isIdentifier(name) ||
    isStringLiteral(name) ||
    isNoSubstitutionTemplateLiteral(name) ||
    isNumericLiteral(name) ||
    (isComputedPropertyName(name) && literalValue(name.expression))
  );
}

/** Primitive literal returns do not call application code or read an environment. */
function literalValue(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword
  );
}
