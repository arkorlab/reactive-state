import {
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type ArrowFunction,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isReturnStatement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import { framedQuietData, framedQuietSource } from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeErrorCreation } from './framed-receivers.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { framedAssignedValues } from './framed-writes.ts';

/** A necessarily invoked synchronous JSON root reviver retains its quiet direct Error result. */

const PARSE = new Set(['JSON.parse']);
const ERRORS = new Set([
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);
const NATIVES = new Set(PARSE);
for (const name of ERRORS) NATIVES.add(name);
type Callback = ArrowFunction | FunctionExpression | FunctionDeclaration;

/** Only direct written native parses and original callback returns add an Error origin. */
export function framedJsonReviverResult(
  node: Expression,
  keys: readonly string[],
  error: (value: Expression, keys: readonly string[]) => boolean,
): true | undefined {
  const selected = selectedParse(node, keys);
  if (selected === undefined || !framedQuietTextPrefix(selected.call, NATIVES)) return undefined;
  const { call } = selected;
  const source = call.arguments[0];
  const callback = call.arguments[1];
  if (
    source === undefined ||
    callback === undefined ||
    !validJson(source) ||
    call.arguments.slice(2).some((argument) => !framedQuietData(argument))
  )
    return undefined;
  const fn = callbackOf(callback);
  if (
    fn === undefined ||
    answersLater(fn) ||
    fn.parameters.some((parameter) => {
      return (
        !isIdentifier(parameter.name) ||
        parameter.initializer !== undefined ||
        parameter.dotDotDotToken !== undefined
      );
    })
  )
    return undefined;
  const returned = returnedValue(fn);
  if (
    returned === undefined ||
    !framedOriginCoowned(returned, call) ||
    !originalError(returned, call)
  )
    return undefined;
  return error(returned, selected.keys) ? true : undefined;
}

/** Original selector nodes retain a member path without creating substitute syntax. */
function selectedParse(
  node: Expression,
  keys: readonly string[],
): { readonly call: CallExpression; readonly keys: readonly string[] } | undefined {
  const path = [...keys];
  let value = unwrapped(node);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return undefined;
    path.unshift(key);
    value = unwrapped(value.expression);
  }
  return isCallExpression(value) && framedNativeConstructor(value.expression, PARSE)
    ? { call: value, keys: path }
    : undefined;
}

/** Literal valid JSON necessarily calls the root reviver without application input conversion. */
function validJson(source: Expression): boolean {
  const value = framedQuietSource(source, false);
  if (value === undefined || (!isStringLiteral(value) && !isNoSubstitutionTemplateLiteral(value)))
    return false;
  try {
    JSON.parse(value.text);
    return true;
  } catch {
    return false;
  }
}

/** Whole immutable aliases and unchanged named declarations retain the source callable identity. */
function callbackOf(expression: Expression): Callback | undefined {
  let value: Node = unwrapped(expression);
  const seen = new Set<Node>();
  for (;;) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (isArrowFunction(value) || isFunctionExpression(value) || isFunctionDeclaration(value))
      return value;
    if (!isIdentifier(value) || framedAssignedValues(value).length > 0) return undefined;
    const declaration = frameDeclarationOf(value);
    if (declaration !== undefined && isFunctionDeclaration(declaration)) return declaration;
    if (
      declaration === undefined ||
      !isVariableDeclaration(declaration) ||
      !isVariableDeclarationList(declaration.parent) ||
      !/^const\b/u.test(declaration.parent.getText(declaration.getSourceFile())) ||
      declaration.initializer === undefined
    )
      return undefined;
    value = unwrapped(declaration.initializer);
  }
}

/** A direct expression or single return after literal directives performs no earlier callback work. */
function returnedValue(fn: Callback): Expression | undefined {
  const { body } = fn;
  if (body === undefined) return undefined;
  if (!isBlock(body)) return body;
  const statements = [...body.statements];
  const last = statements.pop();
  if (
    last === undefined ||
    !isReturnStatement(last) ||
    statements.some(
      (statement) => !isExpressionStatement(statement) || !isStringLiteral(statement.expression),
    )
  )
    return undefined;
  return last.expression;
}

/** Provided/caught inputs keep the original exposure proof; fresh native Errors need quiet arguments. */
function originalError(source: Expression, call: CallExpression): boolean {
  if (framedNativeErrorInput(source, call, undefined, false)) return true;
  const value = unwrapped(source);
  return (
    (isCallExpression(value) || isNewExpression(value)) &&
    framedNativeErrorCreation(value, ERRORS) &&
    (value.arguments ?? []).every((argument) => framedQuietData(argument))
  );
}
