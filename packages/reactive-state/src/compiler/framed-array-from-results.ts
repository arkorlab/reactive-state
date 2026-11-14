import {
  type ArrowFunction,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ParameterDeclaration,
} from 'typescript/ast';

import { answersLater, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietData,
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeErrorCreation } from './framed-receivers.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { framedAssignedValues } from './framed-writes.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { isTypeOnly } from './scope.ts';

/** Closed native Array.from mappers run for every finite source position, including holes. */

const FROM = new Set(['Array.from']);
const ERRORS = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);
const NATIVES = new Set(FROM);
for (const name of ERRORS) NATIVES.add(name);
type Mapper = ArrowFunction | FunctionExpression | FunctionDeclaration;

interface Selection {
  readonly call: CallExpression;
  readonly index: number;
  readonly keys: readonly string[];
}

/** Only a finite native source and a necessarily invoked quiet mapper establish a selected result. */
export function framedArrayFromResult(
  node: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean {
  const selected = selectionOf(node, keys);
  if (selected === undefined) return false;
  const { call } = selected;
  const args = framedArgumentPrefix(call);
  const source = args.values[0];
  const callback = args.values[1];
  if (
    source === undefined ||
    callback === undefined ||
    args.unknown ||
    args.alternatives !== undefined
  )
    return false;
  const fn = mapperOf(callback);
  const returned = fn === undefined ? undefined : mapperReturn(fn);
  if (fn === undefined || returned === undefined || !quietArguments(call.arguments, callback))
    return false;
  const literal = framedQuietSource(source);
  if (literal === undefined || !isArrayLiteralExpression(literal)) return false;
  const values = framedAppliedArguments(call, literal);
  const slots = values === undefined ? [] : mappedSlots(values, selected.index);
  if (slots.length === 0) return false;
  if (
    !framedQuietTextPrefix(call, NATIVES) ||
    !framedQuietTextPrefix(node, NATIVES, (prior) => prior === call)
  )
    return false;
  const given = inputReturn(fn, returned);
  return slots.some((value) => {
    if (given && isSpreadElement(value)) return true;
    const result = given ? value : returned;
    return (
      !isOmittedExpression(unwrapped(result)) &&
      sparseConstructionQuiet(value, call, node) &&
      originalError(result, node) &&
      error(result, selected.keys)
    );
  });
}

/**
 * The written elements the mapped slot may come from: its own, up to the first spread; from there
 * on a spread supplies a length the compile does not read, so every element written after it and
 * the spread itself may be the one at the slot. A spread that may supply the input is taken for an
 * error (the caller refuses more, never less), where counting past it would take another element
 * for the slot's.
 */
function mappedSlots(values: readonly Expression[], index: number): readonly Expression[] {
  const spread = values.findIndex((each) => isSpreadElement(each));
  if (spread === -1 || index < spread) {
    const value = values[index];
    return value === undefined ? [] : [value];
  }
  return values.slice(spread);
}

/** The added sparse mapper proof cannot pass a construction of native nonconstructible Array.from. */
function sparseConstructionQuiet(
  value: Expression,
  call: CallExpression,
  consumer: Expression,
): boolean {
  return (
    !isOmittedExpression(unwrapped(value)) ||
    (constructionPrefixQuiet(call) && constructionPrefixQuiet(consumer))
  );
}

/** Source-written prior work and complete original arguments exclude deferred callable bodies. */
function constructionPrefixQuiet(consumer: Expression): boolean {
  const owner = constructionOwner(consumer);
  const pending: Node[] = [owner];
  const seen = new Set<Node>();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (seen.has(node) || node.pos >= consumer.end || isTypeOnly(node)) continue;
    seen.add(node);
    if (isNewExpression(node) && framedNativeConstructor(node.expression, FROM)) return false;
    pending.push(...constructionInputs(node, owner));
  }
  return true;
}

/** Deferred callable bodies contribute only their immediately evaluated computed name. */
function constructionInputs(node: Node, owner: Node): readonly Node[] {
  if (
    node !== owner &&
    (isAnswering(node) || isConstructorDeclaration(node) || isSetAccessorDeclaration(node))
  ) {
    const name = 'name' in node ? node.name : undefined;
    return name !== undefined && isComputedPropertyName(name) ? [name] : [];
  }
  const following: Node[] = [];
  if (isIdentifier(node)) {
    const source = framedQuietSource(node);
    if (source !== undefined && source !== node) following.push(source);
  }
  node.forEachChild((child) => {
    following.push(child);
  });
  return following;
}

/** The enclosing evaluated body keeps computed callable names in their outer source owner. */
function constructionOwner(consumer: Expression): Node {
  for (
    let parent = consumer.parent, within: Node = consumer;
    ;
    within = parent, parent = parent.parent
  ) {
    if (isSourceFile(parent)) return parent;
    if (
      !isAnswering(parent) &&
      !isConstructorDeclaration(parent) &&
      !isSetAccessorDeclaration(parent)
    )
      continue;
    const regions: readonly (Node | undefined)[] = [parent.body, ...parametersOf(parent)];
    if (regions.includes(within)) return parent;
  }
}

/** A source callback parameter has an actual declaration before it can denote the selected input. */
function inputReturn(fn: Mapper, returned: Expression): boolean {
  const first = parametersOf(fn)[0];
  const value = unwrapped(returned);
  return first !== undefined && isIdentifier(value) && frameDeclarationOf(value) === first;
}

/** Literal selectors retain their original order; effects inside a selector keep their opacity. */
function selectionOf(node: Expression, keys: readonly string[]): Selection | undefined {
  let value = unwrapped(node);
  const path = [...keys];
  const seen = new Set<Expression>();
  for (;;) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
      const key = quietMemberName(value);
      if (key === undefined) return undefined;
      path.unshift(key);
      value = unwrapped(value.expression);
      continue;
    }
    if (!isIdentifier(value)) break;
    const original = framedQuietSource(value);
    if (original === undefined || original === value) return undefined;
    value = unwrapped(original);
  }
  return nativeSelection(value, path);
}

/** A literal member name has no intervening selector conversion or application call. */
function quietMemberName(value: Expression): string | undefined {
  return isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression)
    ? undefined
    : frameMemberName(value);
}

/** Only a finite numeric slot on a written native Array.from result adds a selected Error. */
function nativeSelection(value: Expression, path: readonly string[]): Selection | undefined {
  const [key, ...keys] = path;
  return key !== undefined &&
    /^(?:0|[1-9]\d*)$/u.test(key) &&
    isCallExpression(value) &&
    framedNativeConstructor(value.expression, FROM)
    ? { call: value, index: Number(key), keys }
    : undefined;
}

/** The callback identity is immutable; unknown or reassigned local implementations remain opaque. */
function mapperOf(expression: Expression): Mapper | undefined {
  let value: Node = unwrapped(expression);
  const seen = new Set<Node>();
  for (;;) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (isArrowFunction(value) || isFunctionExpression(value) || isFunctionDeclaration(value))
      return value;
    if (!isIdentifier(value) || framedAssignedValues(value).length > 0) return undefined;
    const declared = frameDeclarationOf(value);
    if (declared !== undefined && isFunctionDeclaration(declared)) return declared;
    if (
      declared === undefined ||
      !isVariableDeclaration(declared) ||
      !isVariableDeclarationList(declared.parent) ||
      !/^const\b/u.test(declared.parent.getText(declared.getSourceFile())) ||
      declared.initializer === undefined
    )
      return undefined;
    value = unwrapped(declared.initializer);
  }
}

/** A synchronous direct return after optional literal directives performs no earlier mapper work. */
function mapperReturn(fn: Mapper): Expression | undefined {
  if (
    answersLater(fn) ||
    parametersOf(fn).some((parameter) => {
      return (
        !isIdentifier(parameter.name) ||
        parameter.initializer !== undefined ||
        parameter.dotDotDotToken !== undefined
      );
    })
  )
    return undefined;
  const { body } = fn;
  if (body === undefined) return undefined;
  if (!isBlock(body)) return body;
  const statements = [...body.statements];
  const last = statements.pop();
  return last !== undefined &&
    isReturnStatement(last) &&
    statements.every(
      (statement) => isExpressionStatement(statement) && isStringLiteral(statement.expression),
    )
    ? last.expression
    : undefined;
}

/** The optional syntax list excludes a leading this declaration, which consumes no runtime input. */
function parametersOf(fn: {
  readonly parameters: readonly ParameterDeclaration[];
}): readonly ParameterDeclaration[] {
  const parameters = fn.parameters;
  const [first, ...rest] = parameters;
  return first !== undefined && isIdentifier(first.name) && first.name.text === 'this'
    ? rest
    : parameters;
}

/** Every original argument is evaluated, including ignored tails and finite spread containers. */
function quietArguments(args: readonly Expression[], callback: Expression): boolean {
  const pending = [...args];
  const seen = new Set<Expression>();
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (value === callback || unwrapped(value) === unwrapped(callback)) continue;
    if (framedQuietInputs([value], NATIVES)) continue;
    const source = framedQuietSource(isSpreadElement(value) ? value.expression : value);
    if (source === undefined || seen.has(source) || !isArrayLiteralExpression(source)) return false;
    seen.add(source);
    pending.push(...source.elements);
  }
  return true;
}

/** Original inputs and fresh native Error constructions retain their own words and source owner. */
function originalError(source: Expression, consumer: Expression): boolean {
  if (!framedOriginCoowned(source, consumer)) return false;
  if (framedNativeErrorInput(source, consumer)) return true;
  const value = unwrapped(source);
  return (
    (isCallExpression(value) || isNewExpression(value)) &&
    framedNativeErrorCreation(value, ERRORS) &&
    (value.arguments ?? []).every((argument) => framedQuietData(argument))
  );
}
