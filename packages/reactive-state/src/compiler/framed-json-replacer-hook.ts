import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  isStringLiteral,
  type ObjectLiteralExpression,
  type ObjectLiteralElementLike,
  type PropertyName,
  type VariableDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { framedJsonKeys, jsonConstantDeclaration } from './framed-json-keys.ts';
import { quietJsonReplacerEvaluation } from './framed-json-replacer-evaluation.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietData } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** A closed comma property list may replace one fresh literal prototype's writable toJSON. */

const ASSIGN = new Set(['Object.assign']);
const PROTOTYPE = new Set(['Object.getPrototypeOf']);

interface LiteralSource {
  readonly value: ObjectLiteralExpression;
  readonly aliases: ReadonlySet<VariableDeclaration>;
}

interface ReplacerHook {
  readonly value: Expression;
  readonly names: readonly string[];
}

interface ReplacerWrite {
  readonly comma: BinaryExpression;
  readonly mutation: CallExpression;
  readonly names: readonly string[];
}

/** Only one proved native prototype write adds a replacement, which JSON does not transform again. */
export function framedJsonReplacerHook(
  call: CallExpression,
  root: Expression,
  replacer: Expression,
  args: readonly Expression[],
): ReplacerHook | undefined {
  const selected = knownReplacer(replacer, args);
  if (selected === undefined) return undefined;
  const { comma, mutation, names } = selected;
  const operands = exactArguments(mutation, 2);
  const target = operands?.[0];
  const fields = operands?.[1];
  if (target === undefined || fields === undefined) return undefined;
  const prototypeRead = unwrapped(target);
  if (
    !isCallExpression(prototypeRead) ||
    !framedNativeConstructor(prototypeRead.expression, PROTOTYPE)
  )
    return undefined;
  const prototypeArgs = exactArguments(prototypeRead, 1);
  const receiver = prototypeArgs?.[0];
  if (receiver === undefined) return undefined;
  const source = freshRoot(root, receiver, call);
  if (source === undefined) return undefined;
  const prototype = sourcePrototype(source.value, call);
  const returned = assignedHook(fields);
  if (prototype === undefined || returned === undefined || !writableHook(prototype.value))
    return undefined;
  if (
    !quietJsonReplacerEvaluation({
      call,
      args,
      comma,
      mutation,
      prototypeRead,
      creations: [source.value, prototype.value],
      returned,
    })
  )
    return undefined;
  return { value: unaliasedHookValue(returned), names };
}

/** The proved unchanged Error alias keeps its original source, without re-reading stored holders. */
function unaliasedHookValue(expression: Expression): Expression {
  let value = unwrapped(expression);
  const seen = new Set<VariableDeclaration>();
  while (isIdentifier(value)) {
    const declared = jsonConstantDeclaration(value);
    if (declared?.initializer === undefined || seen.has(declared)) break;
    seen.add(declared);
    value = unwrapped(declared.initializer);
  }
  return value;
}

/** One comma prefix retains a complete primitive list and quiet spacing or ignored native arguments. */
function knownReplacer(
  expression: Expression,
  args: readonly Expression[],
): ReplacerWrite | undefined {
  const comma = unwrapped(expression);
  if (!isBinaryExpression(comma) || comma.operatorToken.kind !== SyntaxKind.CommaToken)
    return undefined;
  const mutation = unwrapped(comma.left);
  const names = framedJsonKeys(comma.right);
  if (
    names === undefined ||
    !isCallExpression(mutation) ||
    !framedNativeConstructor(mutation.expression, ASSIGN) ||
    !framedQuietData(comma.right) ||
    args.slice(2).some((argument) => !framedQuietData(argument))
  )
    return undefined;
  return { comma, mutation, names };
}

/** Resolved direct native operands have no unknown spread, tail or replacement alternative. */
function exactArguments(call: CallExpression, count: number): readonly Expression[] | undefined {
  const prefix = framedArgumentPrefix(call, call.arguments, Infinity);
  return prefix.unknown || prefix.alternatives !== undefined || prefix.values.length !== count
    ? undefined
    : prefix.values;
}

/** Both reads must select the same fresh whole constant object, without an own toJSON shadow. */
function freshRoot(
  root: Expression,
  receiver: Expression,
  consumer: CallExpression,
): LiteralSource | undefined {
  const source = literalSource(root, consumer);
  const target = literalSource(receiver, consumer);
  if (
    source === undefined ||
    target?.value !== source.value ||
    !plainLiteral(source.value) ||
    source.value.properties.some((property) => literalFieldName(property) === 'toJSON')
  )
    return undefined;
  const aliases = new Set([...source.aliases, ...target.aliases]);
  const allowed = new Set([unwrapped(receiver), unwrapped(root)]);
  return argumentArrayExposed(consumer, aliases, (name) => allowed.has(name), false)
    ? undefined
    : source;
}

/** A literal prototype field is evaluated once before the native assignment and remains unexposed. */
function sourcePrototype(
  source: ObjectLiteralExpression,
  consumer: CallExpression,
): LiteralSource | undefined {
  const fields = source.properties.filter((property) => literalFieldName(property) === '__proto__');
  const field = fields[0];
  if (field === undefined || fields.length !== 1 || !isPropertyAssignment(field)) return undefined;
  const prototype = literalSource(field.initializer, consumer);
  if (prototype === undefined || !plainLiteral(prototype.value)) return undefined;
  const allowed = new Set([unwrapped(field.initializer)]);
  return argumentArrayExposed(consumer, prototype.aliases, (name) => allowed.has(name), false)
    ? undefined
    : prototype;
}

/** Same-owner immutable aliases are followed only after their declaration has completed. */
function literalSource(
  expression: Expression,
  consumer: CallExpression,
): LiteralSource | undefined {
  let value = unwrapped(expression);
  const aliases = new Set<VariableDeclaration>();
  while (isIdentifier(value)) {
    const declared = jsonConstantDeclaration(value);
    if (
      declared?.initializer === undefined ||
      aliases.has(declared) ||
      declared.end > consumer.pos ||
      !framedPrefixSameOwner(declared, consumer)
    )
      return undefined;
    aliases.add(declared);
    value = unwrapped(declared.initializer);
  }
  return isObjectLiteralExpression(value) ? { value, aliases } : undefined;
}

/** Static own data and ordinary methods cannot install a getter or computed field effect. */
function plainLiteral(value: ObjectLiteralExpression): boolean {
  return value.properties.every((property) => {
    return (
      (isPropertyAssignment(property) || isMethodDeclaration(property)) &&
      literalFieldName(property) !== undefined
    );
  });
}

/** An existing literal data property is writable, independently of the value it used to hold. */
function writableHook(value: ObjectLiteralExpression): boolean {
  return value.properties.some((property) => literalFieldName(property) === 'toJSON');
}

/** The sole assign source creates one synchronous direct-return toJSON function. */
function assignedHook(expression: Expression): Expression | undefined {
  const value = unwrapped(expression);
  if (!isObjectLiteralExpression(value) || value.properties.length !== 1) return undefined;
  const field = value.properties[0];
  if (field === undefined || literalFieldName(field) !== 'toJSON') return undefined;
  const fn = isMethodDeclaration(field) ? field : fieldFunction(field);
  if (
    fn === undefined ||
    (!isArrowFunction(fn) && !isFunctionExpression(fn) && !isMethodDeclaration(fn)) ||
    answersLater(fn) ||
    fn.body === undefined ||
    fn.parameters.some(
      (parameter) => !isIdentifier(parameter.name) || parameter.initializer !== undefined,
    )
  )
    return undefined;
  if (!isBlock(fn.body)) return fn.body;
  const statement = fn.body.statements[0];
  if (statement === undefined || fn.body.statements.length !== 1 || !isReturnStatement(statement))
    return undefined;
  return statement.expression;
}

/** A source-written function value is selected without following callable aliases or getters. */
function fieldFunction(field: ObjectLiteralElementLike): Expression | undefined {
  return isPropertyAssignment(field) ? unwrapped(field.initializer) : undefined;
}

/** Spread elements supply no own static name in the compiler AST. */
function literalFieldName(field: ObjectLiteralElementLike): string | undefined {
  return literalName('name' in field ? field.name : undefined);
}

/** Only direct identifier and string names retain literal own-property semantics. */
function literalName(name: PropertyName | undefined): string | undefined {
  return name !== undefined && (isIdentifier(name) || isStringLiteral(name))
    ? name.text
    : undefined;
}
