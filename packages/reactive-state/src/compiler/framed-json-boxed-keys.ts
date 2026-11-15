import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isOmittedExpression,
  isPropertyAccessExpression,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedJsonBoxedConversion, framedJsonBoxedSource } from './framed-json-boxed-origins.ts';
import { framedQuietInputs, framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { isTypeOnly } from './scope.ts';

/** A closed source-written own toString refines a boxed JSON property-list key at its invocation. */

const CONSTRUCTIONS = new Set([
  ...STANDARD_ERRORS,
  'AggregateError',
  'DOMException',
  'Number',
  'String',
]);
const NATIVES = new Set([...CONSTRUCTIONS, 'JSON.stringify', 'Reflect.apply']);
const SLOTS = { gap: 2 } as const;

export interface JsonBoxedKeyContext {
  readonly call: CallExpression;
  readonly args: readonly Expression[];
  readonly entries: readonly Expression[];
}

interface ConversionWrite {
  readonly node: BinaryExpression;
  readonly member: Expression;
  readonly text: string;
}

/** Unknown conversion bodies and effects retain the existing boxed-literal interpretation. */
export function framedJsonBoxedKey(
  expression: Expression,
  context: JsonBoxedKeyContext,
): string | undefined {
  const root = framedJsonBoxedSource(expression, context.call);
  if (root === undefined || !quietBoxedArguments(context)) return undefined;
  const writes = conversionWrites(root, context.call);
  const last = writes?.at(-1);
  return writes !== undefined && last !== undefined && quietBoxedPrefix(context.call, writes)
    ? last.text
    : undefined;
}

/** Every evaluated wrapper argument and earlier property-list conversion remains closed. */
function quietBoxedArguments(context: JsonBoxedKeyContext): boolean {
  const gap = context.args[SLOTS.gap];
  return (
    (gap === undefined || framedQuietPrimitive(gap)) &&
    framedQuietInputs(context.call.arguments, NATIVES) &&
    context.entries.every((entry) => {
      return (
        isOmittedExpression(unwrapped(entry)) ||
        framedQuietPrimitive(entry) ||
        framedJsonBoxedSource(entry, context.call) !== undefined
      );
    })
  );
}

/** Only direct same-block writes to the selected fresh box establish its nearest own conversion. */
function conversionWrites(
  root: NewExpression,
  consumer: CallExpression,
): readonly ConversionWrite[] | undefined {
  const writes: ConversionWrite[] = [];
  const pending: Node[] = [consumer.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isBinaryExpression(node) && node.end <= consumer.pos) {
      const member = conversionMember(node, root, consumer);
      if (member !== undefined) {
        const text = framedJsonBoxedConversion(node.right, consumer);
        if (text === undefined || !closedConversionWrite(node, consumer)) return undefined;
        writes.push({ node, member, text });
      }
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return writes.toSorted((left, right) => left.node.pos - right.node.pos);
}

/** A literal own toString key cannot execute a separate key conversion. */
function conversionMember(
  node: BinaryExpression,
  root: NewExpression,
  consumer: CallExpression,
): Expression | undefined {
  const left = unwrapped(node.left);
  if (
    (!isPropertyAccessExpression(left) && !isElementAccessExpression(left)) ||
    node.operatorToken.kind !== SyntaxKind.EqualsToken ||
    frameMemberName(left) !== 'toString' ||
    (isElementAccessExpression(left) && !framedQuietPrimitive(left.argumentExpression)) ||
    framedJsonBoxedSource(left.expression, consumer) !== root
  )
    return undefined;
  return left;
}

/** A completed unconditional sibling assignment cannot be a deferred or branch-specific write. */
function closedConversionWrite(node: BinaryExpression, consumer: CallExpression): boolean {
  if (!isExpressionStatement(node.parent)) return false;
  let statement: Node = consumer;
  while (statement.parent !== node.parent.parent && statement.parent !== consumer.getSourceFile())
    statement = statement.parent;
  return statement.parent === node.parent.parent && node.end <= statement.pos;
}

/** The original consumer position includes all earlier owner work, including work before box birth. */
function quietBoxedPrefix(consumer: CallExpression, writes: readonly ConversionWrite[]): boolean {
  const assignments = new Set(writes.map((write) => write.node));
  const members = new Set(writes.map((write) => write.member));
  return framedQuietOwnerPrefix(consumer, {
    reached: true,
    primitive: (value) =>
      (isBinaryExpression(value) && assignments.has(value)) || framedQuietPrimitive(value),
    value: (value) => members.has(value) || framedNativeConstructor(value, NATIVES),
    construct: (value) => {
      return (
        framedNativeConstructor(value.expression, CONSTRUCTIONS) &&
        (value.arguments ?? []).every((argument) => framedQuietPrimitive(argument))
      );
    },
  });
}
