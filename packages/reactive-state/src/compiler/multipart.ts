import {
  type Expression,
  isBinaryExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
  type NewExpression,
  type ObjectLiteralElementLike,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { initializerOf, namesType, parameterOf } from './framed.ts';
import { constantValue } from './numbers.ts';

/** What constructing a Request or Response draws at random for a FormData multipart boundary. */
export function multipartMaking(node: NewExpression, path: string | undefined): string | undefined {
  const first = node.arguments?.[0];
  const bodies = path === 'Response' && first !== undefined ? [first] : requestBodies(node, path);
  return bodies.some((body) => isFormData(body, new Set()))
    ? 'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random'
    : undefined;
}

interface BodyReading {
  readonly bodies: readonly Expression[];
  readonly overwrites: boolean;
}

const EMPTY_BODIES: BodyReading = { bodies: [], overwrites: false };

/** What a Request's options show of its body, after ordinary aliases and object spreads. */
function requestBodies(node: NewExpression, path: string | undefined): readonly Expression[] {
  const options = path === 'Request' ? node.arguments?.[1] : undefined;
  return options === undefined ? [] : bodiesOf(options, new Set()).bodies;
}

/** The surviving body property of options the code writes; none of options it does not show. */
function bodiesOf(node: Expression, seen: Set<Expression>): BodyReading {
  const value = declaredOf(node, seen);
  if (seen.has(value)) {
    return EMPTY_BODIES;
  }
  const following = new Set([...seen, value]);
  const alternatives = selectedValues(value);
  if (alternatives !== undefined) {
    const readings = alternatives.map((each) => bodiesOf(each, new Set(following)));
    return {
      bodies: readings.flatMap((each) => each.bodies),
      overwrites: readings.length > 0 && readings.every((each) => each.overwrites),
    };
  }
  if (!isObjectLiteralExpression(value)) {
    return EMPTY_BODIES;
  }
  let current = EMPTY_BODIES;
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      const spread = bodiesOf(property.expression, new Set(following));
      current = {
        bodies: spread.overwrites ? spread.bodies : [...current.bodies, ...spread.bodies],
        overwrites: current.overwrites || spread.overwrites,
      };
      continue;
    }
    current = propertyBodies(property, current);
  }
  return current;
}

/** What a surviving property proves or may add to the possible request bodies. */
function propertyBodies(property: ObjectLiteralElementLike, previous: BodyReading): BodyReading {
  if (isSpreadAssignment(property)) {
    return previous;
  }
  const key = optionKey(property.name);
  const held = propertyValue(property);
  if (key === 'body') {
    return { bodies: held === undefined ? [] : [held], overwrites: true };
  }
  return key === undefined && held !== undefined && isFormData(held, new Set())
    ? { ...previous, bodies: [...previous.bodies, held] }
    : previous;
}

/** The value an ordinary option property writes, rather than what an accessor may compute. */
function propertyValue(property: ObjectLiteralElementLike): Expression | undefined {
  if (isPropertyAssignment(property)) {
    return property.initializer;
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? property.name
    : undefined;
}

/** The alternatives an expression can select as its value, without interpreting its condition. */
function selectedValues(value: Expression): readonly Expression[] | undefined {
  if (isConditionalExpression(value)) {
    return [value.whenTrue, value.whenFalse];
  }
  if (isBinaryExpression(value)) {
    if (value.operatorToken.kind === SyntaxKind.CommaToken) {
      return [value.right];
    }
    if (
      [
        SyntaxKind.AmpersandAmpersandToken,
        SyntaxKind.BarBarToken,
        SyntaxKind.QuestionQuestionToken,
      ].includes(value.operatorToken.kind)
    ) {
      return [value.left, value.right];
    }
  }
  return undefined;
}

/** What an option's property name writes, including a key computed from constants. */
function optionKey(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return isComputedPropertyName(name) ? constantKey(name.expression, new Set()) : undefined;
}

/** The text of a constant key, including additions of text through aliases. */
function constantKey(node: Expression, seen: Set<Expression>): string | undefined {
  const constant = constantValue(node, initializerOf);
  if (constant !== undefined) {
    return String(constant);
  }
  const value = declaredOf(node, seen);
  if (
    seen.has(value) ||
    !isBinaryExpression(value) ||
    value.operatorToken.kind !== SyntaxKind.PlusToken
  ) {
    return undefined;
  }
  const following = new Set([...seen, value]);
  const left = constantKey(value.left, new Set(following));
  const right = constantKey(value.right, new Set(following));
  return left === undefined || right === undefined ? undefined : left + right;
}

/** Whether a body is FormData the code constructs or a parameter it writes as that type. */
function isFormData(node: Expression, seen: Set<Expression>): boolean {
  const value = declaredOf(node, seen);
  if (seen.has(value)) {
    return false;
  }
  const following = new Set([...seen, value]);
  const alternatives = selectedValues(value);
  if (alternatives !== undefined) {
    return alternatives.some((each) => isFormData(each, new Set(following)));
  }
  if (isNewExpression(value)) {
    return globalPathOf(unwrapped(value.expression))?.join('.') === 'FormData';
  }
  return isIdentifier(value) && namesType(parameterOf(value)?.type, new Set(['FormData']));
}

/** What a body's or options' aliases are initialized from, while following no cycle. */
function declaredOf(node: Expression, seen: Set<Expression>): Expression {
  let value = unwrapped(node);
  while (isIdentifier(value) && !seen.has(value)) {
    const declared = initializerOf(value);
    if (declared === undefined) {
      break;
    }
    seen.add(value);
    value = unwrapped(declared);
  }
  return value;
}
