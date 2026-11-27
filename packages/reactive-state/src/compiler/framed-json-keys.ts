import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isOmittedExpression,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedJsonBoxedKey, type JsonBoxedKeyContext } from './framed-json-boxed-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { repeatedBodyRead } from './framed-writes.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** A JSON property list reads only source-known string and number entries of a real array. */

const BOXED_NUMBERS = new Set(['Number']);
const BOXED_STRINGS = new Set(['String']);
const INDEX = { limit: 4_294_967_295 } as const;

interface KeyWrite {
  readonly node: Node;
  readonly index: number;
  readonly value: Expression;
}

/** Closed same-block index assignments replace their original property-list positions. */
export function framedJsonKeys(
  expression: Expression,
  context?: Omit<JsonBoxedKeyContext, 'entries'>,
): readonly string[] | undefined {
  const aliases = new Set<VariableDeclaration>();
  let value = unwrapped(expression);
  while (isIdentifier(value)) {
    const declared = jsonConstantDeclaration(value);
    if (declared?.initializer === undefined || aliases.has(declared)) return undefined;
    aliases.add(declared);
    value = unwrapped(declared.initializer);
  }
  if (!isArrayLiteralExpression(value) || value.elements.some((each) => isSpreadElement(each)))
    return undefined;
  const writes = propertyListWrites(expression, aliases);
  if (writes === undefined) return undefined;
  const entries = new Map<number, Expression>(value.elements.entries());
  for (const write of writes) entries.set(write.index, write.value);
  const names = new Set<string>();
  const values = [...entries.values()];
  const boxed = context === undefined ? undefined : { ...context, entries: values };
  for (const entry of values) {
    const name = propertyListName(entry, boxed);
    if (name === undefined) return undefined;
    if (name !== null) names.add(name);
  }
  return [...names];
}

/** Whole immutable aliases preserve primitive values without evaluating application calls. */
export function jsonConstantDeclaration(name: Identifier): VariableDeclaration | undefined {
  const declared = frameDeclarationOf(name);
  if (declared === undefined || !isVariableDeclaration(declared)) return undefined;
  const statement = declared.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile())) &&
    isIdentifier(declared.name)
    ? declared
    : undefined;
}

/** String and number literals, including native boxed literals, supply serialized member names. */
function propertyListName(
  expression: Expression,
  context: JsonBoxedKeyContext | undefined,
): string | null | undefined {
  let value = unwrapped(expression);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const initial = jsonConstantDeclaration(value)?.initializer;
    if (initial === undefined) return undefined;
    value = unwrapped(initial);
  }
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (isNumericLiteral(value)) return String(Number(value.text));
  if (
    isOmittedExpression(value) ||
    [SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword].includes(value.kind)
  )
    return null;
  const boxed = boxedPropertyName(value);
  return boxed === undefined || context === undefined
    ? boxed
    : (framedJsonBoxedKey(expression, context) ?? boxed);
}

/** Boxed literal String keys retain text, while boxed Number keys use native numeric conversion. */
function boxedPropertyName(value: Expression): string | undefined {
  if (!isNewExpression(value)) return undefined;
  const numeric = framedNativeConstructor(value.expression, BOXED_NUMBERS);
  if (!numeric && !framedNativeConstructor(value.expression, BOXED_STRINGS)) return undefined;
  const argument = value.arguments?.[0];
  if (argument === undefined || value.arguments?.length !== 1 || isSpreadElement(argument))
    return undefined;
  const primitive = unwrapped(argument);
  if (isStringLiteral(primitive) || isNoSubstitutionTemplateLiteral(primitive))
    return numeric ? String(Number(primitive.text)) : primitive.text;
  return isNumericLiteral(primitive) ? String(Number(primitive.text)) : undefined;
}

/** Earlier uses outside closed writes or alias links lose the exact property-list proof. */
function propertyListWrites(
  expression: Expression,
  aliases: ReadonlySet<VariableDeclaration>,
): readonly KeyWrite[] | undefined {
  const writes: KeyWrite[] = [];
  const pending: Node[] = [expression.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (propertyListNameRead(node, aliases)) {
      const write = keyUse(node, expression, aliases);
      if (write === null) return undefined;
      if (write !== undefined) writes.push(write);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return writes.toSorted((left, right) => left.node.pos - right.node.pos);
}

/** Only lexical reads of one whole list binding participate in its closed write history. */
function propertyListNameRead(
  node: Node,
  aliases: ReadonlySet<VariableDeclaration>,
): node is Identifier {
  if (!isIdentifier(node) || !readsBinding(node)) return false;
  const binding = frameBindingOf(node)?.binding;
  return binding !== undefined && isVariableDeclaration(binding) && aliases.has(binding);
}

/** Whole aliases and later one-shot uses do not change the list consumed at this invocation. */
function keyUse(
  name: Identifier,
  expression: Expression,
  aliases: ReadonlySet<VariableDeclaration>,
): KeyWrite | null | undefined {
  const declared = frameDeclarationOf(name);
  if (name === unwrapped(expression) || name === declared?.name) return undefined;
  const parent = name.parent;
  if (isVariableDeclaration(parent) && aliases.has(parent) && parent.initializer === name)
    return undefined;
  const owner = executionOwner(expression);
  if (declared === undefined || executionOwner(name) !== owner) return null;
  if (
    (name.pos >= expression.pos || destructuredFirst(expression, name)) &&
    !repeatedBodyRead(name, expression, declared, owner)
  )
    return undefined;
  return closedKeyWrite(name, expression) ?? null;
}

/** A direct same-block numeric slot assignment has no unknown writer or branch ordering. */
function closedKeyWrite(name: Identifier, expression: Expression): KeyWrite | undefined {
  const member = name.parent;
  if (!isElementAccessExpression(member) || member.expression !== name) return undefined;
  const write = member.parent;
  if (
    !isBinaryExpression(write) ||
    write.left !== member ||
    write.operatorToken.kind !== SyntaxKind.EqualsToken ||
    !isExpressionStatement(write.parent)
  )
    return undefined;
  let statement: Node = expression;
  while (statement.parent !== write.parent.parent && statement.parent !== statement.getSourceFile())
    statement = statement.parent;
  if (statement.parent !== write.parent.parent || write.end > statement.pos) return undefined;
  const key = unwrapped(member.argumentExpression);
  if (!isNumericLiteral(key)) return undefined;
  const index = Number(key.text);
  return Number.isSafeInteger(index) && index >= 0 && index < INDEX.limit
    ? { node: write, index, value: write.right }
    : undefined;
}
